import { Menu, Transition } from "@headlessui/react";
import Link from "next/link";
import { Fragment } from "react";
import { BiCloudUpload, BiExtension, BiHome, BiMenu } from "react-icons/bi";

// Plain array of { href, label, icon } - adding a page later is adding an
// entry here, not touching this component's rendering logic.
const NAV_ITEMS = [
  { href: "/", label: "Dashboard", icon: BiHome },
  { href: "/backups", label: "Backups", icon: BiCloudUpload },
  { href: "/widgets", label: "Widgets", icon: BiExtension },
];

export default function NavHeader() {
  return (
    <div className="absolute top-0 left-0 m-4 sm:m-8 z-20">
      <Menu as="div" className="relative inline-block text-left">
        <Menu.Button
          aria-label="Open menu"
          className="flex items-center justify-center w-8 h-8 rounded-md text-theme-500 dark:text-theme-300 hover:bg-theme-200/50 dark:hover:bg-theme-900/40"
        >
          <BiMenu size={20} />
        </Menu.Button>

        <Transition
          as={Fragment}
          enter="transition ease-out duration-100"
          enterFrom="transform opacity-0 scale-95"
          enterTo="transform opacity-100 scale-100"
          leave="transition ease-in duration-75"
          leaveFrom="transform opacity-100 scale-100"
          leaveTo="transform opacity-0 scale-95"
        >
          <Menu.Items className="absolute left-0 z-10 mt-2 w-48 origin-top-left rounded-md bg-theme-200/50 dark:bg-theme-900/50 backdrop-blur-sm shadow-md focus:outline-hidden text-theme-700 dark:text-theme-200">
            <div className="py-1">
              {NAV_ITEMS.map(({ href, label, icon: Icon }) => (
                <Menu.Item key={href} as={Fragment}>
                  <Link
                    href={href}
                    className="flex items-center gap-2 w-full px-3 py-1.5 text-sm hover:bg-theme-300/70 dark:hover:bg-theme-900/70"
                  >
                    <Icon size={16} />
                    {label}
                  </Link>
                </Menu.Item>
              ))}
            </div>
          </Menu.Items>
        </Transition>
      </Menu>
    </div>
  );
}
