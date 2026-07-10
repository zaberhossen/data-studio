import * as React from "react";
import { Input, type InputProps } from "@/components/ui/input";

/** A labeled text input for the auth forms. Server-safe (no hooks). */
export function Field({
  label,
  name,
  ...props
}: { label: string; name: string } & InputProps) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      <Input name={name} {...props} />
    </label>
  );
}
