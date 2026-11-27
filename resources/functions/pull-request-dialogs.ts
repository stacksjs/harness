export function openLegacyBranchDeletion(dialog: HTMLDialogElement | null | undefined, trigger: HTMLButtonElement | null | undefined): void {
  if (!dialog || dialog.open || !trigger || 'commandForElement' in HTMLButtonElement.prototype) return
  const menu = trigger.closest<HTMLElement>('[data-pr-lifecycle-menu]')
  if (!menu) return

  // Older WebViews hide the containing popover when its dialog opens.
  menu.after(dialog)
  dialog.addEventListener('close', () => {
    menu.showPopover()
    trigger.focus()
  }, { once: true })
  dialog.showModal()
}
