import * as assert from "node:assert/strict"
import { describe, test } from "node:test"

import { SETTINGS_PAGE_NAME, mountSettingsPage, type RouterLike, type SettingsPageModule } from "../tui/page-mount.ts"
import { SettingsPageStore } from "../tui/page-store.ts"
import type { SettingsPageProps } from "../tui/settings-page-data.ts"

const PROPS: SettingsPageProps = {
  rpc: () => ({}) as never,
  toast: () => {},
  store: new SettingsPageStore(3),
  onEdit: () => {},
}

function spyRouter(): { router: RouterLike; registered: Array<{ name: string }>; navigated: Array<{ type: string; name: string }> } {
  const registered: Array<{ name: string }> = []
  const navigated: Array<{ type: string; name: string }> = []
  const router: RouterLike = {
    register: (page) => {
      registered.push({ name: page.name })
      return () => {}
    },
    navigate: (destination) => {
      navigated.push({ type: destination.type, name: destination.name })
    },
  }
  return { router, registered, navigated }
}

describe("mountSettingsPage", () => {
  test("registers the page and navigates to it", async () => {
    const { router, registered, navigated } = spyRouter()
    let fallbackCalls = 0

    const result = await mountSettingsPage({
      router,
      load: async () => ({ SettingsPage: () => null }),
      props: PROPS,
      fallback: async () => {
        fallbackCalls++
      },
    })

    assert.equal(result, "page")
    assert.equal(fallbackCalls, 0)
    assert.deepEqual(registered, [{ name: SETTINGS_PAGE_NAME }])
    assert.deepEqual(navigated, [{ type: "plugin", name: SETTINGS_PAGE_NAME }])
  })

  test("render passes the plugin props to the page component", async () => {
    const { router } = spyRouter()
    let page: { name: string; render: (input: { data?: Record<string, unknown> }) => unknown } | undefined
    const inner = router.register
    router.register = (input) => {
      page = input
      return inner(input)
    }

    await mountSettingsPage({
      router,
      load: async () => ({ SettingsPage: (props) => props }),
      props: PROPS,
      fallback: async () => {},
    })

    assert.ok(page, "the page must be registered")
    const rendered = page.render({}) as SettingsPageProps
    assert.equal(rendered.rpc, PROPS.rpc)
    assert.equal(rendered.toast, PROPS.toast)
  })

  test("falls back when the JSX module cannot be loaded", async () => {
    const { router, registered, navigated } = spyRouter()
    const errors: unknown[] = []
    let fallbackCalls = 0

    const result = await mountSettingsPage({
      router,
      load: async () => {
        throw new Error("Cannot find module '@opentui/solid'")
      },
      props: PROPS,
      fallback: async () => {
        fallbackCalls++
      },
      onError: (error) => errors.push(error),
    })

    assert.equal(result, "fallback")
    assert.equal(fallbackCalls, 1)
    assert.equal(registered.length, 0)
    assert.equal(navigated.length, 0)
    assert.match(String((errors[0] as Error).message), /@opentui\/solid/)
  })

  test("falls back when the host has no router", async () => {
    let fallbackCalls = 0
    const result = await mountSettingsPage({
      router: undefined,
      load: async () => ({ SettingsPage: () => null }),
      props: PROPS,
      fallback: async () => {
        fallbackCalls++
      },
    })
    assert.equal(result, "fallback")
    assert.equal(fallbackCalls, 1)
  })

  test("falls back when the module has no page component", async () => {
    const { router } = spyRouter()
    let fallbackCalls = 0
    const result = await mountSettingsPage({
      router,
      load: async () => ({ SettingsPage: undefined }) as unknown as SettingsPageModule,
      props: PROPS,
      fallback: async () => {
        fallbackCalls++
      },
    })
    assert.equal(result, "fallback")
    assert.equal(fallbackCalls, 1)
  })

  test("falls back when register throws", async () => {
    let fallbackCalls = 0
    const result = await mountSettingsPage({
      router: {
        register: () => {
          throw new Error("page limit reached")
        },
        navigate: () => {},
      },
      load: async () => ({ SettingsPage: () => null }),
      props: PROPS,
      fallback: async () => {
        fallbackCalls++
      },
    })
    assert.equal(result, "fallback")
    assert.equal(fallbackCalls, 1)
  })

  test("never throws, even when both page and fallback fail", async () => {
    const result = await mountSettingsPage({
      router: undefined,
      load: async () => {
        throw new Error("boom")
      },
      props: PROPS,
      fallback: async () => {
        throw new Error("fallback exploded")
      },
    })
    assert.equal(result, "fallback")
  })

  test("hands the unregister function to the caller", async () => {
    let unregisterCalls = 0
    let handed: (() => void) | undefined
    const router: RouterLike = {
      register: () => () => {
        unregisterCalls++
      },
      navigate: () => {},
    }

    const result = await mountSettingsPage({
      router,
      load: async () => ({ SettingsPage: () => null }),
      props: PROPS,
      fallback: async () => {},
      onRegistered: (dispose) => {
        handed = dispose
      },
    })

    assert.equal(result, "page")
    assert.equal(typeof handed, "function", "the caller must receive the disposer")
    handed?.()
    assert.equal(unregisterCalls, 1)
  })

  test("treats a missing unregister function as a failed mount", async () => {
    let fallbackCalls = 0
    const result = await mountSettingsPage({
      router: {
        register: (() => undefined) as unknown as RouterLike["register"],
        navigate: () => {},
      },
      load: async () => ({ SettingsPage: () => null }),
      props: PROPS,
      fallback: async () => {
        fallbackCalls++
      },
    })
    assert.equal(result, "fallback", "an un-unregisterable page would break every later open")
    assert.equal(fallbackCalls, 1)
  })

  test("unregisters when navigation fails, leaving no orphan behind", async () => {
    let unregisterCalls = 0
    const result = await mountSettingsPage({
      router: {
        register: () => () => {
          unregisterCalls++
        },
        navigate: () => {
          throw new Error("route unavailable")
        },
      },
      load: async () => ({ SettingsPage: () => null }),
      props: PROPS,
      fallback: async () => {},
    })
    assert.equal(result, "fallback")
    assert.equal(unregisterCalls, 1, "the registration must not outlive a failed navigation")
  })

  test("a host rejecting a duplicate page name falls back cleanly", async () => {
    let live = 0
    let fallbackCalls = 0
    const disposers: Array<() => void> = []
    const router: RouterLike = {
      register: () => {
        if (live > 0) throw new Error(`page already registered: ${SETTINGS_PAGE_NAME}`)
        live++
        return () => {
          live--
        }
      },
      navigate: () => {},
    }

    const first = await mountSettingsPage({
      router,
      load: async () => ({ SettingsPage: () => null }),
      props: PROPS,
      fallback: async () => {
        fallbackCalls++
      },
      onRegistered: (dispose) => disposers.push(dispose),
    })
    assert.equal(first, "page")

    // Second open while the first registration is still live: the host rejects it.
    const second = await mountSettingsPage({
      router,
      load: async () => ({ SettingsPage: () => null }),
      props: PROPS,
      fallback: async () => {
        fallbackCalls++
      },
    })
    assert.equal(second, "fallback")
    assert.equal(fallbackCalls, 1)

    // Releasing the first registration makes the next open work again.
    for (const dispose of disposers) dispose()
    const third = await mountSettingsPage({
      router,
      load: async () => ({ SettingsPage: () => null }),
      props: PROPS,
      fallback: async () => {},
    })
    assert.equal(third, "page")
  })
})
