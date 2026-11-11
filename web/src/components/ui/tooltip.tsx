import type { ComponentProps } from 'react'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'

export const TooltipProvider = TooltipPrimitive.Provider
export const Tooltip = TooltipPrimitive.Root
export const TooltipTrigger = TooltipPrimitive.Trigger

export function TooltipContent(props: ComponentProps<typeof TooltipPrimitive.Content>) {
  return <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content data-slot="tooltip-content" {...props} />
  </TooltipPrimitive.Portal>
}
