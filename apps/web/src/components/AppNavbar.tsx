"use client";

/**
 * The bar that rides the top of every screen inside the app. The rook on the left
 * takes you home. In the middle sit the places you spend your time: talk to Roque
 * with your hand on the trade, let it trade inside your limits, trade against the
 * world, run a plan, read what it has brought you, or go fill your wallet. The
 * inbox carries a count when Roque is waiting on a decision, because a suggestion
 * nobody sees may as well not have been made. On the right, a flat little reminder
 * that this is Sepolia play money, the light switch, and your wallet. The sidebar
 * handle lives out front so the activity log is one tap away and one tap gone.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Hand, Sparkles, Droplets, PanelLeft, Radar, ListOrdered, Inbox } from "lucide-react";
import { useAppData } from "@/providers/AppData";
import { RoqueLogo } from "./RoqueMark";
import { ThemeToggle } from "./ThemeToggle";
import { WalletButton } from "./WalletButton";

const NAV = [
  { href: "/copilot", label: "Copilot", icon: <Hand size={16} /> },
  { href: "/autonomous", label: "Autonomous", icon: <Sparkles size={16} /> },
  { href: "/events", label: "Events", icon: <Radar size={16} /> },
  { href: "/playbooks", label: "Playbooks", icon: <ListOrdered size={16} /> },
  { href: "/inbox", label: "Inbox", icon: <Inbox size={16} /> },
  { href: "/faucet", label: "Faucet", icon: <Droplets size={16} /> },
];

export function AppNavbar({ onToggleSidebar }: { onToggleSidebar: () => void }) {
  const pathname = usePathname();
  const { proposals } = useAppData();
  // Only ever a number the person can act on, so an empty inbox shows nothing.
  const waiting = proposals.data?.length ?? 0;

  return (
    <header className="app-nav">
      <div className="app-nav-left">
        <button
          className="sidebar-handle"
          onClick={onToggleSidebar}
          aria-label="Toggle activity sidebar"
          title="Activity"
        >
          <PanelLeft size={18} />
        </button>
        <Link href="/" className="site-brand" aria-label="Roque home">
          <RoqueLogo size={24} />
        </Link>
      </div>

      <nav className="app-nav-links" aria-label="Sections">
        {NAV.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`app-nav-link ${active ? "is-active" : ""}`}
              aria-current={active ? "page" : undefined}
            >
              {item.icon}
              <span className={active ? "" : "nav-label-hide"}>{item.label}</span>
              {item.href === "/inbox" && waiting > 0 ? (
                <span className="nav-badge" aria-label={`${waiting} waiting`}>
                  {waiting}
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>

      <div className="app-nav-right">
        <span className="testnet-box">Sepolia testnet</span>
        <ThemeToggle />
        <WalletButton />
      </div>
    </header>
  );
}
