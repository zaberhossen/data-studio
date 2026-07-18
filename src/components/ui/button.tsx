// Button primitive — mirrors Supabase's `@supabase/ui` Button so controls read
// identically: a solid 1px border on every variant, a thick brand-tinted
// focus-visible OUTLINE (not a ring), `transition-all` easing, and
// `data-[state=open]` styling for buttons used as dropdown/menu triggers.
//
// Variant names keep this project's shadcn conventions but map onto Supabase's
// button "types":
//   default → primary   secondary → default (neutral fill)   outline → outline
//   ghost → text         destructive → danger                warning/link → new
//
// Sizes are Supabase's exact SIZE_VARIANTS (tiny/small/medium/large/xlarge)
// re-keyed to xs/sm/default/lg/xl. v4 outline utilities are adapted to v3.
import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "relative inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md border text-center font-medium outline-none transition-all duration-200 ease-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // primary
        default:
          "border-brand-500/75 bg-brand-400 text-foreground hover:border-brand-600 hover:bg-brand/80 focus-visible:outline-brand-600 data-[state=open]:bg-brand-400/80 data-[state=open]:outline-brand-600 dark:border-brand/30 dark:bg-brand-500 dark:hover:border-brand dark:hover:bg-brand/50 dark:data-[state=open]:bg-brand-500/80",
        // Supabase "default" — neutral surface fill.
        secondary:
          "border-border bg-secondary text-foreground hover:border-foreground/20 hover:bg-accent focus-visible:outline-border data-[state=open]:bg-accent data-[state=open]:outline-border",
        outline:
          "border-border bg-transparent text-foreground hover:border-foreground/30 focus-visible:outline-border data-[state=open]:border-foreground/30 data-[state=open]:outline-border",
        // Supabase "text".
        ghost:
          "border-transparent bg-transparent text-foreground shadow-none hover:bg-accent focus-visible:outline-border data-[state=open]:bg-accent",
        // Supabase "danger".
        destructive:
          "border-destructive/40 bg-destructive-300 text-foreground hover:border-destructive hover:bg-destructive-400 focus-visible:outline-destructive data-[state=open]:border-destructive data-[state=open]:bg-destructive-400 data-[state=open]:outline-destructive dark:bg-destructive-400 dark:hover:bg-destructive/50 dark:data-[state=open]:bg-destructive/50",
        warning:
          "border-warning/40 bg-warning-300 text-foreground hover:border-warning hover:bg-warning-400 focus-visible:outline-warning data-[state=open]:border-warning data-[state=open]:bg-warning-400 data-[state=open]:outline-warning dark:bg-warning-400 dark:hover:bg-warning/50 dark:data-[state=open]:bg-warning/50",
        link: "border-transparent text-brand-600 shadow-none hover:bg-brand-400 focus-visible:outline-border data-[state=open]:bg-brand-400",
      },
      size: {
        xs: "h-[26px] px-2.5 py-1 text-xs",
        sm: "h-[34px] px-3 py-2 text-sm",
        default: "h-[38px] px-4 py-2 text-sm",
        lg: "h-[42px] px-4 py-2 text-base",
        xl: "h-[50px] px-6 py-3 text-base",
        icon: "h-[34px] w-[34px] p-0",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /** Pill shape (Supabase `rounded` prop). */
  rounded?: boolean;
  /** Full-width block button (Supabase `block` prop). */
  block?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, rounded, block, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(
          buttonVariants({ variant, size }),
          rounded && "rounded-full",
          block && "w-full",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
