// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import * as utils from './utils';
import * as backbonePatch from './backbone-patch';

import * as Backbone from 'backbone';
import $ from 'jquery';

import { NativeView } from './nativeview';

import { JSONObject } from '@lumino/coreutils';

import { Message, MessageLoop } from '@lumino/messaging';

import { Widget, Panel } from '@lumino/widgets';

import { LayoutModel } from './widget_layout';

import { StyleModel } from './widget_style';

import { IWidgetManager } from './manager';

import { IClassicComm, ICallbacks } from './services-shim';

import { JUPYTER_WIDGETS_VERSION } from './version';

import { Dict } from './utils';

import { KernelMessage } from '@jupyterlab/services';

/**
 * Replace model ids with models recursively.
 */
export function unpack_models(
  value: any | Dict<unknown> | string | (Dict<unknown> | string)[],
  manager: IWidgetManager
): Promise<WidgetModel | Dict<WidgetModel> | WidgetModel[] | any> {
  if (Array.isArray(value)) {
    const unpacked: any[] = [];
    value.forEach((sub_value, key) => {
      unpacked.push(unpack_models(sub_value, manager));
    });
    return Promise.all(unpacked);
  } else if (value instanceof Object && typeof value !== 'string') {
    const unpacked: { [key: string]: any } = {};
    Object.keys(value).forEach((key) => {
      unpacked[key] = unpack_models(value[key], manager);
    });
    return utils.resolvePromisesDict(unpacked);
  } else if (typeof value === 'string' && value.slice(0, 10) === 'IPY_MODEL_') {
    // get_model returns a promise already (except when it returns undefined!)
    return Promise.resolve(manager.get_model(value.slice(10, value.length)));
  } else {
    return Promise.resolve(value);
  }
}

/**
 * Type declaration for general widget serializers.
 */
export interface ISerializers {
  [key: string]: {
    deserialize?: (value?: any, manager?: IWidgetManager) => any;
    serialize?: (value?: any, widget?: WidgetModel) => any;
  };
}

export interface IBackboneModelOptions extends Backbone.ModelSetOptions {
  model_id: string;
  comm?: any;
  widget_manager: any;
}

export class WidgetModel extends Backbone.Model {
  /**
   * The default attributes.
   */
  defaults(): Backbone.ObjectHash {
    return {
      _model_module: '@jupyter-widgets/base',
      _model_name: 'WidgetModel',
      _model_module_version: JUPYTER_WIDGETS_VERSION,
      _view_module: '@jupyter-widgets/base',
      _view_name: null as string | null,
      _view_module_version: JUPYTER_WIDGETS_VERSION,
      _view_count: null as number | null,
    };
  }

  /**
   * Test to see if the model has been synced with the server.
   *
   * #### Notes
   * As of backbone 1.1, backbone ignores `patch` if it thinks the
   * model has never been pushed.
   */
  isNew(): boolean {
    return false;
  }

  /**
   * Constructor
   *
   * Initializes a WidgetModel instance. Called by the Backbone constructor.
   *
   * Parameters
   * ----------
   * widget_manager : WidgetManager instance
   * model_id : string
   *      An ID unique to this model.
   * comm : Comm instance (optional)
   */
  initialize(
    attributes: Backbone.ObjectHash,
    options: IBackboneModelOptions
  ): void {
    super.initialize(attributes, options);

    // Attributes should be initialized here, since user initialization may depend on it
    this.widget_manager = options.widget_manager;
    this.model_id = options.model_id;
    const comm = options.comm;

    this.views = Object.create(null);
    this.state_change = Promise.resolve();

    this._closed = false;
    this._state_lock = null;
    this._msg_buffer = null;
    this._msg_buffer_callbacks = null;
    this._pending_msgs = 0;

    // _buffered_state_diff must be created *after* the super.initialize
    // call above. See the note in the set() method below.
    this._buffered_state_diff = {};

    if (comm) {
      // Remember comm associated with the model.
      this.comm = comm;

      // Hook comm messages up to model.
      comm.on_close(this._handle_comm_closed.bind(this));
      comm.on_msg(this._handle_comm_msg.bind(this));

      this.comm_live = true;
    } else {
      this.comm_live = false;
    }
  }

  get comm_live(): boolean {
    return this._comm_live;
  }
  set comm_live(x) {
    this._comm_live = x;
    this.trigger('comm_live_update');
  }

  /**
   * Send a custom msg over the comm.
   */
  send(
    content: {},
    callbacks: {},
    buffers?: ArrayBuffer[] | ArrayBufferView[]
  ): void {
    if (this.comm !== undefined) {
      const data = { method: 'custom', content: content };
      this.comm.send(data, callbacks, {}, buffers);
    }
  }

  /**
   * Close model
   *
   * @param comm_closed - true if the comm is already being closed. If false, the comm will be closed.
   *
   * @returns - a promise that is fulfilled when all the associated views have been removed.
   */
  close(comm_closed = false): Promise<void> {
    // can only be closed once.
    if (this._closed) {
      return Promise.resolve();
    }
    this._closed = true;
    if (this.comm && !comm_closed) {
      this.comm.close();
    }
    this.stopListening();
    this.trigger('destroy', this);
    if (this.comm) {
      delete this.comm;
    }
    // Delete all views of this model
    if (this.views) {
      const views = Object.keys(this.views).map((id: string) => {
        return this.views![id].then((view) => view.remove());
      });
      delete this.views;
      return Promise.all(views).then(() => {
        return;
      });
    }
    return Promise.resolve();
  }

  /**
   * Handle when a widget comm is closed.
   */
  _handle_comm_closed(msg: KernelMessage.ICommCloseMsg): void {
    this.trigger('comm:close');
    this.close(true);
  }

  /**
   * Handle incoming comm msg.
   */
  _handle_comm_msg(msg: KernelMessage.ICommMsgMsg): Promise<void> {
    const data = msg.content.data as any;
    const method = data.method;
    switch (method) {
      case 'update':
        this.state_change = this.state_change
          .then(() => {
            const state = data.state;
            const buffer_paths = data.buffer_paths || [];
            const buffers = msg.buffers || [];
            utils.put_buffers(state, buffer_paths, buffers);
            return (this.constructor as typeof WidgetModel)._deserialize_state(
              state,
              this.widget_manager
            );
          })
          .then((state) => {
            this.set_state(state);
          })
          .catch(
            utils.reject(
              `Could not process update msg for model id: ${this.model_id}`,
              true
            )
          );
        return this.state_change;
      case 'custom':
        this.trigger('msg:custom', data.content, msg.buffers);
        return Promise.resolve();
    }
    return Promise.resolve();
  }

  /**
   * Handle when a widget is updated from the backend.
   *
   * This function is meant for internal use only. Values set here will not be propagated on a sync.
   */
  set_state(state: Dict<unknown>): void {
    this._state_lock = state;
    try {
      this.set(state);
    } catch (e) {
      console.error(`Error setting state: ${e.message}`);
    } finally {
      this._state_lock = null;
    }
  }

  /**
   * Get the serializable state of the model.
   *
   * If drop_default is truthy, attributes that are equal to their default
   * values are dropped.
   */
  get_state(drop_defaults?: boolean): JSONObject {
    const fullState = this.attributes;
    if (drop_defaults) {
      // if defaults is a function, call it
      const d = this.defaults;
      const defaults = typeof d === 'function' ? d.call(this) : d;
      const state: JSONObject = {};
      Object.keys(fullState).forEach((key) => {
        if (!utils.isEqual(fullState[key], defaults[key])) {
          state[key] = fullState[key];
        }
      });
      return state;
    } else {
      return { ...fullState };
    }
  }

  /**
   * Handle status msgs.
   *
   * execution_state : ('busy', 'idle', 'starting')
   */
  _handle_status(msg: KernelMessage.IStatusMsg): void {
    if (this.comm !== void 0) {
      if (msg.content.execution_state === 'idle') {
        this._pending_msgs--;
        // Send buffer if one is waiting and we are below the throttle.
        if (this._msg_buffer !== null && this._pending_msgs < 1) {
          this.send_sync_message(this._msg_buffer, this._msg_buffer_callbacks);
          this._msg_buffer = null;
          this._msg_buffer_callbacks = null;
        }
      }
    }
  }

  /**
   * Create msg callbacks for a comm msg.
   */
  callbacks(view?: WidgetView): ICallbacks {
    return this.widget_manager.callbacks(view);
  }

  /**
   * Set one or more values.
   *
   * We just call the super method, in which val and options are optional.
   * Handles both "key", value and {key: value} -style arguments.
   */
  set(key: any, val?: any, options?: any): any {
    // Call our patched backbone set. See #1642 and #1643.
    const return_value = backbonePatch.set.call(this, key, val, options);

    // Backbone only remembers the diff of the most recent set()
    // operation.  Calling set multiple times in a row results in a
    // loss of change information.  Here we keep our own running diff.
    //
    // We don't buffer the state set in the constructor (including
    // defaults), so we first check to see if we've initialized _buffered_state_diff.
    // which happens after the constructor sets attributes at creation.
    if (this._buffered_state_diff !== void 0) {
      const attrs = this.changedAttributes() || {};

      // The state_lock lists attributes that are currently being changed
      // right now from a kernel message. We don't want to send these
      // non-changes back to the kernel, so we delete them out of attrs if
      // they haven't changed from their state_lock value.
      // The state lock could be null or undefined (if set is being called from
      // the initializer).
      if (this._state_lock) {
        for (const key of Object.keys(this._state_lock)) {
          if (attrs[key] === this._state_lock[key]) {
            delete attrs[key];
          }
        }
      }

      // _buffered_state_diff_synced lists things that have already been sent to the kernel during a top-level call to .set(), so we don't need to buffer these things either.
      if (this._buffered_state_diff_synced) {
        for (const key of Object.keys(this._buffered_state_diff_synced)) {
          if (attrs[key] === this._buffered_state_diff_synced[key]) {
            delete attrs[key];
          }
        }
      }

      this._buffered_state_diff = utils.assign(
        this._buffered_state_diff,
        attrs
      );
    }

    // If this ended a top-level call to .set, then reset _buffered_state_diff_synced
    if ((this as any)._changing === false) {
      this._buffered_state_diff_synced = {};
    }
    return return_value;
  }

  /**
   * Handle sync to the back-end.  Called when a model.save() is called.
   *
   * Make sure a comm exists.
   *
   * Parameters
   * ----------
   * method : create, update, patch, delete, read
   *   create/update always send the full attribute set
   *   patch - only send attributes listed in options.attrs, and if we
   *   are queuing up messages, combine with previous messages that have
   *   not been sent yet
   * model : the model we are syncing
   *   will normally be the same as `this`
   * options : dict
   *   the `attrs` key, if it exists, gives an {attr: value} dict that
   *   should be synced, otherwise, sync all attributes.
   *
   */
  sync(method: string, model: WidgetModel, options: any = {}): any {
    // the typing is to return `any` since the super.sync method returns a JqXHR, but we just return false if there is an error.
    if (this.comm === undefined) {
      throw 'Syncing error: no comm channel defined';
    }

    const attrs =
      method === 'patch'
        ? options.attrs
        : model.get_state(options.drop_defaults);

    // The state_lock lists attributes that are currently being changed
    // right now from a kernel message. We don't want to send these
    // non-changes back to the kernel, so we delete them out of attrs if
    // they haven't changed from their state_lock value.
    // The state lock could be null or undefined (if this is triggered
    // from the initializer).
    if (this._state_lock) {
      for (const key of Object.keys(this._state_lock)) {
        if (attrs[key] === this._state_lock[key]) {
          delete attrs[key];
        }
      }
    }

    const msgState = this.serialize(attrs);

    if (Object.keys(msgState).length > 0) {
      // If this message was sent via backbone itself, it will not
      // have any callbacks.  It's important that we create callbacks
      // so we can listen for status messages, etc...
      const callbacks = options.callbacks || this.callbacks();

      // Check throttle.
      if (this._pending_msgs >= 1) {
        // The throttle has been exceeded, buffer the current msg so
        // it can be sent once the kernel has finished processing
        // some of the existing messages.
        // Combine updates if it is a 'patch' sync, otherwise replace updates
        switch (method) {
          case 'patch':
            this._msg_buffer = utils.assign(this._msg_buffer || {}, msgState);
            break;
          case 'update':
          case 'create':
            this._msg_buffer = msgState;
            break;
          default:
            throw 'unrecognized syncing method';
        }
        this._msg_buffer_callbacks = callbacks;
      } else {
        // We haven't exceeded the throttle, send the message like
        // normal.
        this.send_sync_message(attrs, callbacks);
        // Since the comm is a one-way communication, assume the message
        // arrived and was processed successfully.
        // Don't call options.success since we don't have a model back from
        // the server. Note that this means we don't have the Backbone
        // 'sync' event.
      }
    }
  }

  /**
   * Serialize widget state.
   *
   * A serializer is a function which takes in a state attribute and a widget,
   * and synchronously returns a JSONable object. The returned object will
   * have toJSON called if possible, and the final result should be a
   * primitive object that is a snapshot of the widget state that may have
   * binary array buffers.
   */
  serialize(state: Dict<any>): JSONObject {
    const serializers =
      (this.constructor as typeof WidgetModel).serializers || {};
    for (const k of Object.keys(state)) {
      try {
        if (serializers[k] && serializers[k].serialize) {
          state[k] = serializers[k].serialize!(state[k], this);
        } else {
          // the default serializer just deep-copies the object
          state[k] = JSON.parse(JSON.stringify(state[k]));
        }
        if (state[k] && state[k].toJSON) {
          state[k] = state[k].toJSON();
        }
      } catch (e) {
        console.error('Error serializing widget state attribute: ', k);
        throw e;
      }
    }
    return state;
  }

  /**
   * Send a sync message to the kernel.
   */
  send_sync_message(state: JSONObject, callbacks: any = {}): void {
    if (!this.comm) {
      return;
    }
    try {
      callbacks.iopub = callbacks.iopub || {};
      const statuscb = callbacks.iopub.status;
      callbacks.iopub.status = (msg: KernelMessage.IStatusMsg): void => {
        this._handle_status(msg);
        if (statuscb) {
          statuscb(msg);
        }
      };

      // split out the binary buffers
      const split = utils.remove_buffers(state);
      this.comm.send(
        {
          method: 'update',
          state: split.state,
          buffer_paths: split.buffer_paths,
        },
        callbacks,
        {},
        split.buffers
      );
      this._pending_msgs++;
    } catch (e) {
      console.error('Could not send widget sync message', e);
    }
  }

  /**
   * Push this model's state to the back-end
   *
   * This invokes a Backbone.Sync.
   */
  save_changes(callbacks?: {}): void {
    if (this.comm_live) {
      const options: any = { patch: true };
      if (callbacks) {
        options.callbacks = callbacks;
      }
      this.save(this._buffered_state_diff, options);

      // If we are currently in a .set() call, save what state we have synced
      // to the kernel so we don't buffer it again as we come out of the .set call.
      if ((this as any)._changing) {
        utils.assign(
          this._buffered_state_diff_synced,
          this._buffered_state_diff
        );
      }
      this._buffered_state_diff = {};
    }
  }

  /**
   * on_some_change(['key1', 'key2'], foo, context) differs from
   * on('change:key1 change:key2', foo, context).
   * If the widget attributes key1 and key2 are both modified,
   * the second form will result in foo being called twice
   * while the first will call foo only once.
   */
  on_some_change(
    keys: string[],
    callback: (...args: any[]) => void,
    context: any
  ): void {
    this.on(
      'change',
      (...args) => {
        if (keys.some(this.hasChanged, this)) {
          callback.apply(context, args);
        }
      },
      this
    );
  }

  /**
   * Serialize the model.  See the deserialization function at the top of this file
   * and the kernel-side serializer/deserializer.
   */
  toJSON(options?: {}): string {
    return `IPY_MODEL_${this.model_id}`;
  }

  /**
   * Returns a promise for the deserialized state. The second argument
   * is an instance of widget manager, which is required for the
   * deserialization of widget models.
   */
  static _deserialize_state(
    state: JSONObject,
    manager: IWidgetManager
  ): Promise<utils.Dict<unknown>> {
    const serializers = this.serializers;
    let deserialized: Dict<any>;
    if (serializers) {
      deserialized = {};
      for (const k in state) {
        if (serializers[k] && serializers[k].deserialize) {
          deserialized[k] = serializers[k].deserialize!(state[k], manager);
        } else {
          deserialized[k] = state[k];
        }
      }
    } else {
      deserialized = state;
    }
    return utils.resolvePromisesDict(deserialized);
  }

  static serializers: ISerializers;

  // Backbone calls the overridden initialization function from the
  // constructor. We initialize the default values above in the initialization
  // function so that they are ready for the user code, and to not override
  // values subclasses may set in their initialization functions.
  widget_manager: IWidgetManager;
  model_id: string;
  views?: { [key: string]: Promise<WidgetView> };
  state_change: Promise<any>;
  comm?: IClassicComm;
  name: string;
  module: string;

  private _comm_live: boolean;
  private _closed: boolean;
  private _state_lock: any;
  private _buffered_state_diff: any;
  private _buffered_state_diff_synced: any;
  private _msg_buffer: any;
  private _msg_buffer_callbacks: any;
  private _pending_msgs: number;
}

export class DOMWidgetModel extends WidgetModel {
  static serializers: ISerializers = {
    ...WidgetModel.serializers,
    layout: { deserialize: unpack_models },
    style: { deserialize: unpack_models },
  };

  defaults(): Backbone.ObjectHash {
    return utils.assign(super.defaults(), {
      _dom_classes: [],
      tabbable: null,
      tooltip: null,
      // We do not declare defaults for the layout and style attributes.
      // Those defaults are constructed on the kernel side and synced here
      // as needed, and our code here copes with those attributes being
      // undefined. See
      // https://github.com/jupyter-widgets/ipywidgets/issues/1620 and
      // https://github.com/jupyter-widgets/ipywidgets/pull/1621
    });
  }
}

export class WidgetView extends NativeView<WidgetModel> {
  /**
   * Public constructor.
   */
  constructor(options?: Backbone.ViewOptions<WidgetModel> & { options?: any }) {
    super(options);
  }

  /**
   * Initializer, called at the end of the constructor.
   */
  initialize(parameters: WidgetView.IInitializeParameters): void {
    this.listenTo(this.model, 'change', () => {
      const changed = Object.keys(this.model.changedAttributes() || {});
      if (changed[0] === '_view_count' && changed.length === 1) {
        // Just the view count was updated
        return;
      }
      this.update();
    });

    this.options = parameters.options;

    this.once('remove', () => {
      if (typeof this.model.get('_view_count') === 'number') {
        this.model.set('_view_count', this.model.get('_view_count') - 1);
        this.model.save_changes();
      }
    });

    this.once('displayed', () => {
      if (typeof this.model.get('_view_count') === 'number') {
        this.model.set('_view_count', this.model.get('_view_count') + 1);
        this.model.save_changes();
      }
    });

    this.displayed = new Promise((resolve, reject) => {
      this.once('displayed', resolve);

      this.model.on('msg:custom', this.handle_message.bind(this));
    });
  }

  /**
   * Handle message sent to the front end.
   *
   * Used to focus or blur the widget.
   */
  handle_message(content: any): void {
    if (content.do === 'focus') {
      this.el.focus();
    } else if (content.do === 'blur') {
      this.el.blur();
    }
  }

  /**
   * Triggered on model change.
   *
   * Update view to be consistent with this.model
   */
  update(options?: any): void {
    return;
  }

  /**
   * Render a view
   *
   * @returns the view or a promise to the view.
   */
  render(): any {
    return;
  }

  /**
   * Create and promise that resolves to a child view of a given model
   */
  create_child_view<VT extends DOMWidgetView = DOMWidgetView>(
    child_model: DOMWidgetModel,
    options?: any
  ): Promise<VT>;
  create_child_view<VT extends WidgetView = WidgetView>(
    child_model: WidgetModel,
    options?: any
  ): Promise<VT>;
  create_child_view<VT extends WidgetView = WidgetView>(
    child_model: WidgetModel,
    options = {}
  ): Promise<VT> {
    options = { parent: this, ...options };
    return this.model.widget_manager
      .create_view<VT>(child_model, options)
      .catch(utils.reject('Could not create child view', true));
  }

  /**
   * Create msg callbacks for a comm msg.
   */
  callbacks(): ICallbacks {
    return this.model.callbacks(this);
  }

  /**
   * Send a custom msg associated with this view.
   */
  send(content: {}, buffers?: ArrayBuffer[] | ArrayBufferView[]): void {
    this.model.send(content, this.callbacks(), buffers);
  }

  touch(): void {
    this.model.save_changes(this.callbacks());
  }

  remove(): any {
    // Raise a remove event when the view is removed.
    super.remove();
    this.trigger('remove');
    return this;
  }

  options: any;

  /**
   * A promise that resolves to the parent view when a child view is displayed.
   */
  displayed: Promise<WidgetView>;
}

export namespace WidgetView {
  export interface IInitializeParameters<T extends WidgetModel = WidgetModel>
    extends Backbone.ViewOptions<T> {
    options: any;
  }
}

export namespace JupyterLuminoWidget {
  export interface IOptions {
    view: DOMWidgetView;
  }
}

export class JupyterLuminoWidget extends Widget {
  constructor(options: Widget.IOptions & JupyterLuminoWidget.IOptions) {
    const view = options.view;
    // Cast as any since we cannot delete a mandatory value
    delete (options as any).view;
    super(options);
    this._view = view;
  }

  /**
   * Dispose the widget.
   *
   * This causes the view to be destroyed as well with 'remove'
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    super.dispose();
    this._view.remove();
    this._view = null!;
  }

  /**
   * Process the Lumino message.
   *
   * Any custom Lumino widget used inside a Jupyter widget should override
   * the processMessage function like this.
   */
  processMessage(msg: Message): void {
    super.processMessage(msg);
    this._view.processLuminoMessage(msg);
  }

  private _view: DOMWidgetView;
}

export class JupyterLuminoPanelWidget extends Panel {
  constructor(options: JupyterLuminoWidget.IOptions & Panel.IOptions) {
    const view = options.view;
    delete (options as any).view;
    super(options);
    this._view = view;
  }

  /**
   * Process the Lumino message.
   *
   * Any custom Lumino widget used inside a Jupyter widget should override
   * the processMessage function like this.
   */
  processMessage(msg: Message): void {
    super.processMessage(msg);
    this._view.processLuminoMessage(msg);
  }

  /**
   * Dispose the widget.
   *
   * This causes the view to be destroyed as well with 'remove'
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    super.dispose();
    this._view.remove();
    this._view = null!;
  }

  private _view: DOMWidgetView;
}

export class DOMWidgetView extends WidgetView {
  /**
   * Public constructor
   */
  initialize(parameters: WidgetView.IInitializeParameters): void {
    super.initialize(parameters);

    this.listenTo(
      this.model,
      'change:_dom_classes',
      (model: WidgetModel, new_classes: string[]) => {
        const old_classes = model.previous('_dom_classes');
        this.update_classes(old_classes, new_classes);
      }
    );

    this.layoutPromise = Promise.resolve();
    this.listenTo(
      this.model,
      'change:layout',
      (model: WidgetModel, value: WidgetModel) => {
        this.setLayout(value, model.previous('layout'));
      }
    );

    this.stylePromise = Promise.resolve();
    this.listenTo(
      this.model,
      'change:style',
      (model: WidgetModel, value: WidgetModel) => {
        this.setStyle(value, model.previous('style'));
      }
    );

    this.displayed.then(() => {
      this.update_classes([], this.model.get('_dom_classes'));
      this.setLayout(this.model.get('layout'));
      this.setStyle(this.model.get('style'));
    });

    this._comm_live_update();
    this.listenTo(this.model, 'comm_live_update', () => {
      this._comm_live_update();
    });
    this.listenTo(this.model, 'change:tooltip', this.updateTooltip);
    this.updateTooltip();
  }

  setLayout(layout: LayoutModel, oldLayout?: LayoutModel): void {
    if (layout) {
      this.layoutPromise = this.layoutPromise.then((oldLayoutView) => {
        if (oldLayoutView) {
          oldLayoutView.unlayout();
          this.stopListening(oldLayoutView.model);
          oldLayoutView.remove();
        }

        return this.create_child_view(layout)
          .then((view) => {
            // Trigger the displayed event of the child view.
            return this.displayed.then(() => {
              view.trigger('displayed');
              this.listenTo(view.model, 'change', () => {
                // Post (asynchronous) so layout changes can take
                // effect first.
                MessageLoop.postMessage(
                  this.luminoWidget,
                  Widget.ResizeMessage.UnknownSize
                );
              });
              MessageLoop.postMessage(
                this.luminoWidget,
                Widget.ResizeMessage.UnknownSize
              );
              this.trigger('layout-changed');
              return view;
            });
          })
          .catch(
            utils.reject('Could not add LayoutView to DOMWidgetView', true)
          );
      });
    }
  }

  setStyle(style: StyleModel, oldStyle?: StyleModel): void {
    if (style) {
      this.stylePromise = this.stylePromise.then((oldStyleView) => {
        if (oldStyleView) {
          oldStyleView.unstyle();
          this.stopListening(oldStyleView.model);
          oldStyleView.remove();
        }

        return this.create_child_view(style)
          .then((view) => {
            // Trigger the displayed event of the child view.
            return this.displayed.then(() => {
              view.trigger('displayed');
              this.trigger('style-changed');
              // Unlike for the layout attribute, style changes don't
              // trigger Lumino resize messages.
              return view;
            });
          })
          .catch(
            utils.reject('Could not add styleView to DOMWidgetView', true)
          );
      });
    }
  }

  updateTooltip(): void {
    const title = this.model.get('tooltip');
    if (!title) {
      this.el.removeAttribute('title');
    } else if (this.model.get('description').length === 0) {
      this.el.setAttribute('title', title);
    }
  }

  /**
   * Update the DOM classes applied to an element, default to this.el.
   */
  update_classes(
    old_classes: string[],
    new_classes: string[],
    el?: HTMLElement
  ): void {
    if (el === undefined) {
      el = this.el;
    }
    utils.difference(old_classes, new_classes).map(function (c) {
      if (el!.classList) {
        // classList is not supported by IE for svg elements
        el!.classList.remove(c);
      } else {
        el!.setAttribute('class', el!.getAttribute('class')!.replace(c, ''));
      }
    });
    utils.difference(new_classes, old_classes).map(function (c) {
      if (el!.classList) {
        // classList is not supported by IE for svg elements
        el!.classList.add(c);
      } else {
        el!.setAttribute('class', el!.getAttribute('class')!.concat(' ', c));
      }
    });
  }

  /**
   * Update the DOM classes applied to the widget based on a single
   * trait's value.
   *
   * Given a trait value classes map, this function automatically
   * handles applying the appropriate classes to the widget element
   * and removing classes that are no longer valid.
   *
   * Parameters
   * ----------
   * class_map: dictionary
   *  Dictionary of trait values to class lists.
   *  Example:
   *      {
   *          success: ['alert', 'alert-success'],
   *          info: ['alert', 'alert-info'],
   *          warning: ['alert', 'alert-warning'],
   *          danger: ['alert', 'alert-danger']
   *      };
   * trait_name: string
   *  Name of the trait to check the value of.
   * el: optional DOM element handle, defaults to this.el
   *  Element that the classes are applied to.
   */
  update_mapped_classes(
    class_map: Dict<string[]>,
    trait_name: string,
    el?: HTMLElement
  ): void {
    let key = this.model.previous(trait_name) as string;
    const old_classes = class_map[key] ? class_map[key] : [];
    key = this.model.get(trait_name);
    const new_classes = class_map[key] ? class_map[key] : [];

    this.update_classes(old_classes, new_classes, el || this.el);
  }

  set_mapped_classes(
    class_map: Dict<string[]>,
    trait_name: string,
    el?: HTMLElement
  ): void {
    const key = this.model.get(trait_name);
    const new_classes = class_map[key] ? class_map[key] : [];
    this.update_classes([], new_classes, el || this.el);
  }

  _setElement(el: HTMLElement): void {
    if (this.luminoWidget) {
      this.luminoWidget.dispose();
    }

    this.$el = el instanceof $ ? el : $(el);
    this.el = this.$el[0];
    this.luminoWidget = new JupyterLuminoWidget({
      node: el,
      view: this,
    });
  }

  remove(): any {
    if (this.luminoWidget) {
      this.luminoWidget.dispose();
    }
    return super.remove();
  }

  processLuminoMessage(msg: Message): void {
    switch (msg.type) {
      case 'after-attach':
        this.trigger('displayed');
        break;
      case 'show':
        this.trigger('shown');
        break;
    }
  }

  private _comm_live_update(): void {
    if (this.model.comm_live) {
      this.luminoWidget.removeClass('jupyter-widgets-disconnected');
    } else {
      this.luminoWidget.addClass('jupyter-widgets-disconnected');
    }
  }

  updateTabindex(): void {
    const tabbable = this.model.get('tabbable');
    if (tabbable === true) {
      this.el.setAttribute('tabIndex', '0');
    } else if (tabbable === false) {
      this.el.setAttribute('tabIndex', '-1');
    } else if (tabbable === null) {
      this.el.removeAttribute('tabIndex');
    }
  }
  el: HTMLElement; // Override typing
  '$el': any;
  luminoWidget: Widget;
  layoutPromise: Promise<any>;
  stylePromise: Promise<any>;
}
