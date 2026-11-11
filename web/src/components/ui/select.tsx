import type { ComponentProps } from 'react'
import * as SelectPrimitive from '@radix-ui/react-select'
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

// shadcn/ui Select, styled with the chat page's control tokens.
export const Select = SelectPrimitive.Root
export const SelectValue = SelectPrimitive.Value

export function SelectTrigger({ children, className, ...props }: ComponentProps<typeof SelectPrimitive.Trigger>) {
  return <SelectPrimitive.Trigger data-slot="select-trigger" className={cn('select-trigger', className)} {...props}>
    {children}
    <SelectPrimitive.Icon asChild><ChevronDownIcon aria-hidden="true" /></SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
}

export function SelectContent({ children, ...props }: ComponentProps<typeof SelectPrimitive.Content>) {
  return <SelectPrimitive.Portal>
    <SelectPrimitive.Content data-slot="select-content" className="select-content" position="popper" align="start" sideOffset={4} collisionPadding={8} {...props}>
      <SelectPrimitive.ScrollUpButton className="select-scroll"><ChevronUpIcon aria-hidden="true" /></SelectPrimitive.ScrollUpButton>
      <SelectPrimitive.Viewport className="select-options">{children}</SelectPrimitive.Viewport>
      <SelectPrimitive.ScrollDownButton className="select-scroll"><ChevronDownIcon aria-hidden="true" /></SelectPrimitive.ScrollDownButton>
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
}

export function SelectItem({ children, ...props }: ComponentProps<typeof SelectPrimitive.Item>) {
  return <SelectPrimitive.Item data-slot="select-item" className="select-item" {...props}>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    <SelectPrimitive.ItemIndicator><CheckIcon aria-hidden="true" /></SelectPrimitive.ItemIndicator>
  </SelectPrimitive.Item>
}
