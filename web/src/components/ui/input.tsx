import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input data-slot="input" className={cn('h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm disabled:opacity-50', className)} {...props} />
}
