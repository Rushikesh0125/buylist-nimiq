import { createPortal } from "react-dom";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { CaretDown, SignOut, UserCircle } from "@phosphor-icons/react";
import type { User } from "./api";

export default function AccountMenu({
  user,
  busy,
  onLogout,
}: {
  user: User;
  busy: boolean;
  onLogout: () => void;
}) {
  const target = document.getElementById("site-account-slot");
  if (!target) return null;
  return createPortal(
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className="account-menu-trigger" aria-label="Account menu">
          <UserCircle size={22} />
          <span>Account</span>
          <CaretDown size={13} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="account-menu-content"
          align="end"
          sideOffset={10}
        >
          <DropdownMenu.Label className="account-menu-label">
            {user.name}
          </DropdownMenu.Label>
          <DropdownMenu.Separator className="account-menu-separator" />
          <DropdownMenu.Item
            className="account-menu-item"
            disabled={busy}
            onSelect={onLogout}
          >
            <SignOut size={18} />
            Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>,
    target,
  );
}
