import { createContext, useContext, useState, useSyncExternalStore, type ReactElement, type ReactNode, type Ref } from 'react'
import * as Sheet from '@radix-ui/react-dialog'
import { PanelLeftIcon } from 'lucide-react'
import { Button } from './button'

// shadcn/ui Sidebar's desktop offcanvas and mobile Sheet, scoped to the left rail.
const mobileQuery = '(max-width: 600px)'
const sidebarId = 'chat-sidebar'
const SidebarContext = createContext<{ mobile: boolean; open: boolean; toggle: () => void } | null>(null)

function subscribeToViewport(update: () => void) {
  const query = window.matchMedia?.(mobileQuery)
  query?.addEventListener('change', update)
  return () => query?.removeEventListener('change', update)
}

function useSidebar() {
  const sidebar = useContext(SidebarContext)
  if (!sidebar) throw new Error('SidebarProvider is required')
  return sidebar
}

export function SidebarProvider({ children }: { children: ReactNode }) {
  const mobile = useSyncExternalStore(subscribeToViewport, () => window.matchMedia?.(mobileQuery).matches ?? false)
  const [openDesktop, setOpenDesktop] = useState(true)
  const [openMobile, setOpenMobile] = useState(false)
  const open = mobile ? openMobile : openDesktop
  return <SidebarContext.Provider value={{ mobile, open, toggle: () => setOpenDesktop(value => !value) }}>
    <Sheet.Root open={mobile && openMobile} onOpenChange={setOpenMobile}>
      <div className="chat-layout" data-slot="sidebar-wrapper" data-sidebar-expanded={!mobile && openDesktop}>
        {children}
      </div>
    </Sheet.Root>
  </SidebarContext.Provider>
}

export function Sidebar({ children }: { children: ReactNode }) {
  const { mobile, open } = useSidebar()
  if (mobile) return <Sheet.Portal>
    <Sheet.Overlay className="sidebar-overlay" />
    <Sheet.Content className="sidebar-sheet" aria-describedby={undefined}>
      <Sheet.Title className="sr-only">侧栏</Sheet.Title>
      <Sheet.Close asChild>
        <Button className="sidebar-sheet-close" type="button" variant="ghost" size="icon" aria-label="收起侧边栏" title="收起侧边栏">
          <PanelLeftIcon aria-hidden="true" />
        </Button>
      </Sheet.Close>
      <aside id={sidebarId} data-slot="sidebar" className="chat-sidebar" aria-label="侧栏">{children}</aside>
    </Sheet.Content>
  </Sheet.Portal>
  return <aside id={sidebarId} data-slot="sidebar" className="chat-sidebar" aria-label="侧栏" hidden={!open}>{children}</aside>
}

export function SidebarTrigger({ ref }: { ref?: Ref<HTMLButtonElement> }) {
  const { mobile, open, toggle } = useSidebar()
  const label = open ? '收起侧边栏' : '展开侧边栏'
  const button = <Button ref={ref} className="sidebar-toggle" type="button" variant="ghost" size="icon" aria-label={label} title={label}
    aria-expanded={open} aria-controls={sidebarId} onClick={mobile ? undefined : toggle}>
    <PanelLeftIcon aria-hidden="true" />
  </Button>
  return mobile ? <Sheet.Trigger asChild>{button}</Sheet.Trigger> : button
}

export function SidebarDismiss({ children }: { children: ReactElement }) {
  const { mobile } = useSidebar()
  return mobile ? <Sheet.Close asChild>{children}</Sheet.Close> : children
}
