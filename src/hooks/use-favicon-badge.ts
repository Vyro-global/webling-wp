"use client";

import { useEffect, useRef } from "react";
import { useTotalUnread } from "./use-total-unread";

const SIZE = 32;
const SCALE = 2;
const CANVAS_SIZE = SIZE * SCALE;

export function useFaviconBadge() {
  const totalUnread = useTotalUnread();

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Keep a reference to the original favicon href so we can restore it
  // when the count drops to zero.
  const originalHrefRef = useRef<string | null>(null);

  useEffect(() => {
    if (!canvasRef.current) {
      canvasRef.current = document.createElement("canvas");
      canvasRef.current.width = CANVAS_SIZE;
      canvasRef.current.height = CANVAS_SIZE;
    }

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    // --- Draw the purple rounded-square background ---
    const r = 6 * SCALE;
    const w = CANVAS_SIZE;
    const h = CANVAS_SIZE;
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(w - r, 0);
    ctx.quadraticCurveTo(w, 0, w, r);
    ctx.lineTo(w, h - r);
    ctx.quadraticCurveTo(w, h, w - r, h);
    ctx.lineTo(r, h);
    ctx.quadraticCurveTo(0, h, 0, h - r);
    ctx.lineTo(0, r);
    ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.closePath();
    ctx.fillStyle = "#7c3aed";
    ctx.fill();

    // --- Draw the chat-bubble icon ---
    const pad = 5 * SCALE;
    const bx = pad;
    const by = pad + 2 * SCALE;
    const bw = w - pad * 2;
    const bh = h - pad * 2 - 3 * SCALE;

    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2.5 * SCALE;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const cr = 3 * SCALE;
    ctx.beginPath();
    // Top edge
    ctx.moveTo(bx + cr, by);
    ctx.lineTo(bx + bw - cr, by);
    ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + cr);
    // Right edge
    ctx.lineTo(bx + bw, by + bh - cr);
    ctx.quadraticCurveTo(bx + bw, by + bh, bx + bw - cr, by + bh);
    // Bottom edge up to tail start
    const tailX = bx + bw * 0.7;
    ctx.lineTo(tailX, by + bh);
    // Tail pointing down-left
    ctx.lineTo(tailX - 3 * SCALE, by + bh + 5 * SCALE);
    ctx.lineTo(tailX - 6 * SCALE, by + bh);
    // Continue bottom edge
    ctx.lineTo(bx + cr, by + bh);
    ctx.quadraticCurveTo(bx, by + bh, bx, by + bh - cr);
    // Left edge
    ctx.lineTo(bx, by + cr);
    ctx.quadraticCurveTo(bx, by, bx + cr, by);
    ctx.closePath();
    ctx.stroke();

    // --- Manage the favicon link element ---
    const link =
      document.querySelector<HTMLLinkElement>('link[rel="icon"]') ??
      document.querySelector<HTMLLinkElement>('link[rel="shortcut icon"]');

    // Store the original href once so we can restore it.
    if (link && originalHrefRef.current === null) {
      originalHrefRef.current = link.href;
    }

    if (totalUnread > 0) {
      // --- Draw the badge ---
      const badge = Math.min(totalUnread, 99);
      const badgeText = badge >= 100 ? "99+" : String(badge);

      const cx = w - 8 * SCALE;
      const cy = 8 * SCALE;
      const badgeR = 7 * SCALE;

      // Red circle
      ctx.beginPath();
      ctx.arc(cx, cy, badgeR, 0, Math.PI * 2);
      ctx.fillStyle = "#ef4444";
      ctx.fill();

      // Dark border ring so it pops against the purple
      ctx.strokeStyle = "#020617";
      ctx.lineWidth = 1.5 * SCALE;
      ctx.stroke();

      // White count text
      ctx.fillStyle = "#ffffff";
      ctx.font = `bold ${badgeText.length > 1 ? 7 * SCALE : 9 * SCALE}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(badgeText, cx, cy + 0.5 * SCALE);

      // Replace the favicon href with the canvas version.
      if (link) {
        link.href = canvas.toDataURL("image/png");
      }
    } else {
      // Restore the original favicon when there are no unread messages.
      if (link && originalHrefRef.current) {
        link.href = originalHrefRef.current;
      }
    }
  }, [totalUnread]);
}
