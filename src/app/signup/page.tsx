"use client";

import * as React from "react";
import Link from "next/link";
import { useFormState, useFormStatus } from "react-dom";
import { signup, type SignupState } from "@/lib/auth/actions";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field } from "@/components/auth/Field";
import { AuthShell } from "@/components/auth/AuthShell";

const INITIAL: SignupState = { error: null };

export default function SignupPage() {
  const [state, action] = useFormState(signup, INITIAL);

  return (
    <AuthShell>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Create your workspace</CardTitle>
          <CardDescription>
            Start a new organization. You&apos;ll be its owner.
          </CardDescription>
        </CardHeader>
        <form action={action}>
          <CardContent className="space-y-4">
            <Field label="Your name" name="name" autoComplete="name" />
            <Field label="Workspace name" name="org" placeholder="Acme Inc." />
            <Field label="Email" name="email" type="email" autoComplete="email" required />
            <Field
              label="Password"
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
            />
            {state.error ? (
              <p className="text-sm text-destructive">{state.error}</p>
            ) : null}
          </CardContent>
          <CardFooter className="flex-col items-stretch gap-3">
            <SubmitButton />
            <p className="text-center text-sm text-muted-foreground">
              Already have an account?{" "}
              <Link href="/login" className="font-medium text-foreground underline">
                Sign in
              </Link>
            </p>
          </CardFooter>
        </form>
      </Card>
    </AuthShell>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Creating…" : "Create account"}
    </Button>
  );
}
