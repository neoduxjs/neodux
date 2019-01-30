import { Store } from './store';

export interface IAction {
  type: string;
  payload?: any;
}

export interface IActionHandlerParams<S = any> {
  state: S;
  action: IAction | undefined;
  dispatch: Function;
}

export type IActionHandler = (params: IActionHandlerParams) => any;

// Handlers registered through action registry
export type Handler<S = any> = (params: {
  state: S;
  payload?: any;
  dispatch: Function;
}) => S;

/*
 * IActionSelectHandler - handles an action dispatched from the store
 *
 * An action handler contains two properties:
 *     1. Selector - the property in the state three the handler is responsible for
 *     2. Handler - a function that accepts the previous value (state) and a payload
 *
 * Example: a simple clock

 * This is the handler responsible for updating the minutes
 * based on a date payload

 * {
 *     selector: 'clock.min',
 *     handler: ({state: number, payload: date}) => returns derived minute from date
 * }
 */
interface IActionSelectHandler {
  selector: string;
  handler: Handler;
}

// ActionHandler guard
function isActionHandler(ah: IActionSelectHandler): ah is IActionSelectHandler {
  return typeof ah.selector === 'string' && typeof ah.handler === 'function';
}

// Association between specific actionType and a handling function
// This is used to craft our dynamic reducer
interface IActionTypeToHandler {
  name: string;
  type: string;
  handler: IActionSelectHandler;
}

export interface ISideEffectParams {
  state: object;
  dispatch: Function;
}

export type SideEffect = (params: ISideEffectParams) => void;

export interface ISideEffectHandler {
  actionType: string;
  handler: SideEffect;
}

// Merge the results of two functions.
/* istanbul ignore next */
const compose = async function(fn: Function, gn: Function) {
  return async function(x: any) {
    return await fn(await gn(x));
  };
};

const generateRandStr = function() {
  return Math.random()
    .toString(36)
    .substring(2);
};

/**
 * ActionRegistry - registry of all ActionHandlers
 */
export class ActionsRegistry {
  private _actionNames: { [name: string]: string } = {};
  private _actionTypes: { [type: string]: boolean } = {}; // track all registered types
  private _actionTypeToHandlers: IActionTypeToHandler[] = [];
  private _sideEffects: { [actionType: string]: ISideEffectHandler[] } = {};

  public register(name: string, actionHandler: IActionSelectHandler): void;
  public register(
    name: string,
    actionType: string,
    actionHandler: IActionSelectHandler
  ): void;

  /**
   * register - register actions handlers
   * @param {string} name - name of the handler
   * @param {string | IActionSelectHandler} action.Type - the string that should cause this handler to run
   * @param {IActionHander} handler
   */
  register(
    name: string,
    actionType: string | IActionSelectHandler,
    actionHandler?: IActionSelectHandler
  ) {
    // Handle Overloading
    if (typeof actionType !== 'string') {
      actionHandler = actionType;
      actionType = generateRandStr();
      /* istanbul ignore next */
      while (this._actionTypes[actionType] !== undefined) {
        actionType = generateRandStr();
      }
    }

    // type assert the actionhandler type so compiler doesn't complain
    actionHandler = <IActionSelectHandler>actionHandler;

    if (this._actionNames[name]) {
      throw new Error(`action with name: "${name}" already exists`);
    }

    /* istanbul ignore next */
    if (!isActionHandler(actionHandler)) {
      throw new Error(
        `selector or handler is not correct; selector=${
          (actionHandler as any).selector
        }`
      );
    }

    // save actionName and actionType association (used to create action creators)
    this._actionNames[name] = actionType;

    // "Map" of all actionTypes
    this._actionTypes[actionType] = true;

    // ActionType to handler association. This is used to craft our reducer.
    this._actionTypeToHandlers.push({
      name,
      type: actionType,
      handler: actionHandler
    });
  }

  /**
   * sideEffect - register a sideEffect
   * @param {object} sideEffectHandler
   */

  sideEffect(s: ISideEffectHandler) {
    if (this._sideEffects[s.actionType]) {
      this._sideEffects[s.actionType].push(s);
    } else {
      this._sideEffects[s.actionType] = [s];
    }
  }

  /**
   * createActionHandler
   * @returns {IReducer} - creates an actionHandler based on the registered actions
   */
  createActionHandler() {
    /*
     * Convert all handlers (deals with payload only)
     * into an action handler format (state, action, dispatch)
     *
     * eg:
     * [{
     *     type: 'INCREMENT',
     *     handler: someFunction({state, payload})
     * }]
     *
     * converted to
     * [{
     *     type: 'INCREMENT',
     *     handler: ({state, action, dispatch}) => ... someFunction({state, payload})
     * }]
     */
    const handlerToActionHandler = this._actionTypeToHandlers.map(function(
      originalIActionToType
    ) {
      const actionHandler = async function(params: IActionHandlerParams) {
        const { state, action, dispatch } = params;
        // get initial state
        if (state === undefined) {
          return await originalIActionToType.handler.handler({
            state: undefined,
            payload: undefined,
            dispatch
          });
        }

        // passthrough for no actions
        if (action === undefined) {
          return state;
        }

        // check if it's the action we care about
        if (action.type === originalIActionToType.type) {
          return await originalIActionToType.handler.handler({
            state,
            payload: action.payload,
            dispatch
          });
        }
        return state;
      };

      return {
        name: originalIActionToType.name,
        type: originalIActionToType.type,
        handler: {
          selector: originalIActionToType.handler.selector,
          handler: actionHandler
        }
      };
    });

    // separate the handlers that act on the "root" level
    // from the ones that are in nested objects.
    const actionTree = handlerToActionHandler.reduce(
      function(accum: any, currTypeReduceHandler) {
        const ah = currTypeReduceHandler.handler;
        const split: string[] = ah.selector.split('.');
        let root = accum;
        let dest = 'root';
        let suffix: string = split[0];
        if (split.length > 1) {
          root = accum.nested;
          suffix = split.pop() as string;
          dest = split.join('.');
          if (root[dest] === undefined) {
            root[dest] = {};
          }
        }

        if (root[dest][suffix] === undefined) {
          root[dest][suffix] = ah.handler;
        } else {
          root[dest][suffix] = compose(
            ah.handler,
            root[ah.selector]
          );
        }
        return accum;
      },
      { root: {}, nested: {} }
    );

    // Create a cached object associating paths in the state tree to reducers.
    // This cache allows us to dynamically traverse the state tree.
    const nestedTraversers = Object.keys(actionTree.nested).reduce(function(
      accum: any,
      key
    ) {
      accum.push({
        path: key.split('.'),
        handler: actionTree.nested[key]
      });
      return accum;
    },
    []);

    // Combine all the action handlers into ONE
    return async function({
      state = {},
      action,
      dispatch
    }: IActionHandlerParams) {
      // root values...
      const rootPromises = Object.keys(actionTree.root).map(async function(
        key
      ) {
        state[key] = await actionTree.root[key]({
          state: state[key],
          action,
          dispatch
        });
      });

      // nested values...
      const nestedPromises = nestedTraversers.map(function(traverser: any) {
        let curr = state;
        const path = traverser.path;
        for (let i = 0; i < path.length; i++) {
          if (curr[path[i]] === undefined) {
            curr[path[i]] = {};
          }
          curr = curr[path[i]];
        }
        return Promise.all(
          Object.keys(traverser.handler).map(async function(key) {
            curr[key] = await traverser.handler[key]({
              state: curr[key],
              action,
              dispatch
            });
          })
        );
      });
      await Promise.all([...rootPromises, ...nestedPromises]);
      return state;
    };
  }

  /**
   * createStore - creates the store based on the registered actions
   * @param {any} initialState
   */
  async createStore(initialState?: any) {
    const store = await new Store(
      this.createActionHandler(),
      this._actionNames,
      this._sideEffects
    );
    await store.init(initialState);
    return store;
  }
}