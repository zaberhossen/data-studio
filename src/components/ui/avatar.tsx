"use client";

/**
 * Avatar — a lightweight, dependency-free avatar (no @radix-ui/react-avatar).
 * Renders an image when `src` loads, otherwise an initials/monogram fallback.
 * Sized via className (defaults to a compact 28px circle for the header).
 */

import * as React from "react";
import { cn } from "@/lib/utils";

interface AvatarProps extends React.HTMLAttributes<HTMLSpanElement> {
  src?: string | null;
  alt?: string;
  /** Fallback content when no image (e.g. initials). */
  fallback?: React.ReactNode;
}

export function Avatar({ src, alt, fallback, className, ...props }: AvatarProps) {
  const [failed, setFailed] = React.useState(false);
  const showImage = src && !failed;

  return (
    <span
      className={cn(
        "relative inline-flex h-7 w-7 shrink-0 select-none items-center justify-center overflow-hidden rounded-full bg-secondary text-xs font-medium text-secondary-foreground",
        className,
      )}
      {...props}
    >
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element -- external avatar URL, no next/image loader configured
        <img
          src={src}
          alt={alt ?? ""}
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        fallback
      )}
    </span>
  );
}
