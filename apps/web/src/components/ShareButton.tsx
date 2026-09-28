"use client";

/**
 * Publish an order or a playbook to a link, then hand over the link. Two states
 * and nothing more: before, a button that says what it will do; after, the url
 * with a copy beside it. The link is deliberately not a share of the position,
 * only of the thinking, so there is nothing here about size or balances.
 */

import { useState } from "react";
import { Check, Copy, Link2 } from "lucide-react";
import { useAppData } from "@/providers/AppData";
import { useToast } from "./Toaster";
import { api } from "@/lib/api";
import type { ShareKind } from "@/lib/types";

export function ShareButton({
  kind,
  id,
  defaultTitle,
}: {
  kind: ShareKind;
  id: string;
  defaultTitle: string;
}) {
  const { address, wallet } = useAppData();
  const toast = useToast();
  const [slug, setSlug] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const url = slug ? `${window.location.origin}/s/${slug}` : null;

  const publish = async () => {
    if (!address) return;
    setBusy(true);
    try {
      const { client } = await wallet.getClient();
      const res = await api.publishShare(
        { kind, id, title: defaultTitle.slice(0, 140) },
        address,
        client,
      );
      setSlug(res.share.slug);
      toast.success("Link is live", "Anyone with it can read the thesis and fork it themselves.");
    } catch (err) {
      toast.error("Could not publish that", (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be blocked; the url is on screen either way.
      toast.info("Copy the link from the box", url);
    }
  };

  if (url) {
    return (
      <span className="share-out">
        <input className="share-url" value={url} readOnly onFocus={(e) => e.target.select()} />
        <button className="btn btn-ghost btn-sm" onClick={() => void copy()} aria-label="Copy link">
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </span>
    );
  }

  return (
    <button className="btn btn-ghost btn-sm" onClick={() => void publish()} disabled={busy}>
      {busy ? <span className="spinner" /> : <Link2 size={14} />}
      Share it
    </button>
  );
}
