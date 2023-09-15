import React, { useMemo } from 'react'
import { useSyncExternalStore } from 'use-sync-external-store/shim'
import {
  __count,
  action,
  Action,
  atom,
  Atom,
  AtomMut,
  AtomState,
  createCtx,
  Ctx,
  CtxSpy,
  Fn,
  isAction,
  isAtom,
  throwReatomError,
} from '@reatom/core'
import { bind, Binded } from '@reatom/lens'

let getName = (type: string): string => {
  let Component =
    // @ts-expect-error do we have another way?
    React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED?.ReactCurrentOwner
      ?.current?.type

  let name = Component?.displayName ?? Component?.name
  return (name && name.concat('.', type)) || `_${type}`
}

let batch = (cb: Fn) => cb()

export const setupBatch = (newBatch: typeof batch) => {
  batch = newBatch
}

export const withBatching = (ctx: Ctx): Ctx => {
  let queue: Array<Fn> = []
  return {
    ...ctx,
    // @ts-ignore
    subscribe: (anAtom, cb) =>
      ctx.subscribe(
        anAtom,
        cb &&
          ((value) =>
            Promise.resolve(queue.push(() => cb(value))).then(
              (length) =>
                length === queue.length &&
                batch(() => queue.splice(0).forEach((cb) => cb())),
            )),
      ),
  }
}

export const reatomContext = React.createContext<null | Ctx>(null)

export const useCtx = (): Ctx => {
  let ctx = React.useContext(reatomContext)

  throwReatomError(
    !ctx,
    'ctx is not set, you probably forgot to specify the ctx provider',
  )

  return ctx!
}

let bindBind = (ctx: Ctx, fn: Fn) => bind(ctx, fn)
export const useCtxBind = (): (<T extends Fn>(fn: T) => Binded<T>) =>
  bind(useCtx(), bindBind)

// use it instead of `setState` to handle HMR
const useRefSetup = <T extends Fn<[], { deps: Array<any> }>>(
  deps: Array<any>,
  setup: T,
): React.MutableRefObject<ReturnType<T>> => {
  let ref = React.useRef<ReturnType<typeof setup>>()
  if (
    ref.current === undefined ||
    ref.current.deps.length !== deps.length ||
    ref.current!.deps.some((v, i) => !Object.is(v, deps[i]!))
  ) {
    // @ts-expect-error
    ref.current = setup()
  }

  // @ts-expect-error
  return ref
}

// @ts-ignore
export const useAtom: {
  <T extends Atom>(
    atom: T,
    deps?: Array<any>,
    options?: boolean | { name?: string; subscribe?: boolean },
  ): [
    AtomState<T>,
    T extends Fn<[Ctx, ...infer Args], infer Res> ? Fn<Args, Res> : undefined,
    T,
    Ctx,
  ]
  <T>(
    init: T | Fn<[CtxSpy], T>,
    deps?: Array<any>,
    options?: boolean | { name?: string; subscribe?: boolean },
  ): [T, Fn<[T | Fn<[T, Ctx], T>], T>, AtomMut<T>, Ctx]
} = (
  anAtom: any,
  userDeps: Array<any> = [],
  options: boolean | { name?: string; subscribe?: boolean } = {},
) => {
  let { name, subscribe = true }: { name?: string; subscribe?: boolean } =
    typeof options === 'boolean' ? { subscribe: options } : options
  let ctx = useCtx()
  let deps: any[] = [ctx]
  if (isAtom(anAtom)) deps.push(anAtom)

  let { theAtom, depsAtom, update, sub, get } = useRefSetup(deps, () => {
    let atomName = getName(name ?? `useAtom#${typeof anAtom}`)
    let depsAtom = atom<any[]>([], `${atomName}._depsAtom`)
    let theAtom = anAtom
    if (!isAtom(theAtom)) {
      theAtom = atom(
        typeof anAtom === 'function'
          ? (ctx: CtxSpy, state?: any) => {
              ctx.spy(depsAtom)
              return anAtom(ctx, state)
            }
          : anAtom,
        atomName,
      )
    }
    let update =
      typeof theAtom === 'function'
        ? // @ts-expect-error
          (...a) => batch(() => theAtom(ctx, ...a))
        : undefined
    let sub = (cb: Fn) => ctx.subscribe(theAtom, cb)
    let get = () => ctx.get(theAtom)

    return { theAtom, depsAtom, update, deps, sub, get, subscribe }
  }).current

  return ctx.get(() => {
    if (!isAtom(anAtom)) {
      const prevDeps = ctx.get(depsAtom)
      if (
        userDeps.length !== prevDeps.length ||
        userDeps.some((dep, i) => !Object.is(dep, prevDeps[i]))
      ) {
        if (typeof anAtom === 'function') depsAtom(ctx, userDeps)
        else update!(ctx, anAtom)
      }
    }

    return [
      subscribe ? useSyncExternalStore(sub, get, get) : get(),
      update,
      theAtom,
      ctx,
    ]
  })
}

export const useAtomCreator = <T extends Atom>(
  creator: Fn<[], T>,
  deps: Array<any> = [],
  options?: { subscribe?: boolean },
) => {
  const ref = useRefSetup(deps, () => ({ deps, theAtom: creator() }))
  return useAtom(ref.current.theAtom, [], options)
}

export const useUpdate = <T extends [any] | Array<any>>(
  cb: Fn<
    [
      Ctx,
      ...{
        [K in keyof T]: T[K] extends Atom ? AtomState<T[K]> : T[K]
      },
    ]
  >,
  deps: T,
): null => {
  const ctx = useCtx()

  React.useEffect(() => {
    const call = (ctx: Ctx) => {
      // @ts-expect-error
      cb(ctx, ...deps.map((thing) => (isAtom(thing) ? ctx.get(thing) : thing)))
    }

    call(ctx)

    deps.forEach(
      (thing, i) =>
        isAtom(thing) && (thing.__reatom.updateHooks ??= new Set()).add(call),
    )

    return () =>
      deps.forEach(
        (thing, i) => isAtom(thing) && thing.__reatom.updateHooks!.delete(call),
      )
  }, deps.concat(ctx))

  return null
}

export const useAction = <T extends Fn<[Ctx, ...Array<any>]>>(
  fn: T,
  deps: Array<any> = [],
  name?: string,
): T extends Fn<[Ctx, ...infer Args], infer Res> ? Fn<Args, Res> : never => {
  deps ??= []
  let ctx = useCtx()
  deps.push(ctx)
  if (isAction(fn)) deps.push(fn)

  let ref = useRefSetup(deps, () => {
    let theAction: Action = isAction(fn)
      ? fn
      : action((...a) => ref.current!.fn(...a), name ?? getName(`useAction`))
    let cb = (...a: Array<any>) => batch(() => theAction(ctx, ...a))
    return { fn, deps, cb }
  })
  React.useLayoutEffect(() => {
    ref.current!.fn = fn
  })

  // @ts-ignore
  return ref.current.cb
}

export const useCreateCtx = (extension?: Fn<[Ctx]>) => {
  const ctxRef = React.useRef(null as null | Ctx)
  if (!ctxRef.current) {
    ctxRef.current = createCtx()
    extension?.(ctxRef.current)
  }
  return ctxRef.current
}

type CtxRender = CtxSpy & { bind<T extends Fn>(fn: T): Binded<T> }
type RenderState = JSX.Element & { REATOM_DEPS_CHANGE?: true }

export const reatomComponent = <T>(
  Component: (props: T & { ctx: CtxRender }) => JSX.Element,
  name = __count('Component'),
): ((props: T) => JSX.Element) => {
  let rendering = false

  return (props) => {
    const { propsAtom, renderAtom } = useMemo(() => {
      const propsAtom = atom<T>(
        {} as T & { ctx: CtxRender },
        `${name}._propsAtom`,
      )
      const renderAtom = atom(
        (ctx: CtxRender, state?: RenderState): RenderState => {
          const { pubs } = ctx.cause
          const props = ctx.spy(propsAtom) as T & { ctx: CtxRender }

          ctx.bind = (fn) => bind(ctx, fn)

          if (rendering) {
            if (state?.REATOM_DEPS_CHANGE) {
              ctx.cause.cause = ctx.get(
                (read) => read(renderAtom.__reatom)!.cause,
              )
            }
            props.ctx = ctx
            return Component(props)
          }

          // do not drop subscriptions from the render
          for (
            // skip `propsAtom`
            let i = 1;
            i < pubs.length;
            i++
          ) {
            // @ts-expect-error we haven't a reference to the atom, but `spy`  reads only `proto`
            ctx.spy({ __reatom: pubs[i]!.proto })
          }

          return { ...state!, REATOM_DEPS_CHANGE: true }
        },
        `${name}._renderAtom`,
      ) as Atom as Atom<RenderState>

      return { propsAtom, renderAtom }
    }, [])
    const ctx = useCtx()
    const [, forceUpdate] = React.useState({} as JSX.Element)
    React.useEffect(
      () =>
        ctx.subscribe(renderAtom, (element) => {
          if (element.REATOM_DEPS_CHANGE) forceUpdate(element)
        }),
      [ctx, forceUpdate],
    )
    return ctx.get(() => {
      propsAtom(ctx, { ...props })
      try {
        rendering = true
        return ctx.get(renderAtom)
      } finally {
        rendering = false
      }
    })
  }
}

const promisesValues = new WeakMap<Promise<any>, any>()
export const useAtomPromise = <T>(theAtom: Atom<Promise<T>>): T => {
  const forceUpdate = React.useReducer((s) => s + 1, 0)[1]
  const promise = useAtom(theAtom)[0]

  if (!promisesValues.has(promise)) {
    promisesValues.set(
      promise,
      promise.then((v) => {
        promisesValues.set(promise, v)
        forceUpdate()
      }),
    )
  }

  const value = promisesValues.get(promise)

  if (value instanceof Promise) throw value

  return value
}
