import { ChevronDown } from "lucide-react";
import { forwardRef, type SelectHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

interface NativeSelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  wrapperClassName?: string;
}

/**
 * Native select with the approved arrow: the browser glyph is removed and one
 * 16px chevron sits 12px from the right edge, vertically centred. Styling in
 * styles.css (`.native-select`).
 */
export const NativeSelect = forwardRef<HTMLSelectElement, NativeSelectProps>(
  function NativeSelect({ wrapperClassName, className, children, ...props }, ref) {
    return (
      <span className={cn("native-select", wrapperClassName)}>
        <select ref={ref} className={className} {...props}>
          {children}
        </select>
        <ChevronDown className="native-select__icon" aria-hidden="true" />
      </span>
    );
  },
);
