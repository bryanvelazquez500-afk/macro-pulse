"use client";

import { motion, useReducedMotion } from "framer-motion";
import { useId } from "react";

import { flow } from "@/lib/motion";

export interface SegmentOption<T extends string> {
  key: T;
  label: React.ReactNode;
  title?: string;
}

/**
 * Segmented control: a pill track whose selected segment is a raised panel thumb that slides between
 * options. `role` picks the ARIA pattern: "radiogroup" (a setting) or "group" with aria-pressed (a toggle).
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  role = "radiogroup",
  size = "md",
  className = "",
}: {
  value: T;
  options: SegmentOption<T>[];
  onChange: (v: T) => void;
  label: string;
  role?: "radiogroup" | "group";
  size?: "sm" | "md";
  className?: string;
}) {
  const id = useId();
  const reduceMotion = useReducedMotion();
  return (
    <div role={role} aria-label={label} className={`seg-track ${size === "sm" ? "seg-sm" : ""} ${className}`}>
      {options.map((o) => {
        const on = o.key === value;
        return (
          <button
            key={o.key}
            type="button"
            title={o.title}
            {...(role === "radiogroup" ? { role: "radio", "aria-checked": on } : { "aria-pressed": on })}
            onClick={() => onChange(o.key)}
            className="seg-item"
          >
            {on && <motion.span layoutId={`${id}-thumb`} className="seg-thumb" transition={reduceMotion ? { duration: 0 } : flow(2)} />}
            <span>{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
