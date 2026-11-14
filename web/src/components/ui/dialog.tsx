import type { ComponentProps } from 'react'
import { useTranslation } from 'react-i18next'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { XIcon } from 'lucide-react'
import { Button } from './button'
import { cn } from '@/lib/utils'

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogTitle = DialogPrimitive.Title
export const DialogDescription = DialogPrimitive.Description

export function DialogContent({ className, overlayClassName, closeLabel, children, ...props }: ComponentProps<typeof DialogPrimitive.Content> & {
  overlayClassName?: string
  closeLabel?: string
}) {
  const { t } = useTranslation()
  return <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay className={cn('dialog-overlay', overlayClassName)} />
    <DialogPrimitive.Content className={cn('dialog-content', className)} {...props}>
      {children}
      <DialogPrimitive.Close asChild>
        <Button className="dialog-close" variant="ghost" size="icon-sm" aria-label={closeLabel ?? t('settings.close')}><XIcon aria-hidden="true" /></Button>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
}
