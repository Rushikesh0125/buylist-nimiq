import { type PropsWithChildren, type InputHTMLAttributes } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
export function MobileScroll({children,className}:PropsWithChildren<{className?:string}>){return <div className={className}>{children}</div>}
export function KeyboardInput(props:InputHTMLAttributes<HTMLInputElement>){return <input {...props}/>}
export function useKeyboard(){return {hide:()=>{if(document.activeElement instanceof HTMLElement)document.activeElement.blur()}}}
export function useKeyboardInsets(){return {bottomInset:0}}
export function BottomSheet({open,onOpenChange,title,description,children}:PropsWithChildren<{open:boolean;onOpenChange:(v:boolean)=>void;title:string;description?:string}>){return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="dialog-overlay"/><Dialog.Content className="bottom-sheet"><Dialog.Title>{title}</Dialog.Title><Dialog.Description>{description}</Dialog.Description>{children}</Dialog.Content></Dialog.Portal></Dialog.Root>}
