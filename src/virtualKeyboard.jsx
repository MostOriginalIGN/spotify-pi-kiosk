import React, { useCallback, useEffect, useState } from "react";
import { CornerDownLeft, Delete } from "lucide-react";

const LETTER_ROWS = [
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
  ["shift", "z", "x", "c", "v", "b", "n", "m", "backspace"],
  ["123", "space", "search"]
];

const NUMBER_ROWS = [
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
  ["-", "_", ".", ",", "'", "!", "?"],
  ["abc", "space", "backspace"],
  ["search"]
];

function detectTouchInput() {
  if (typeof window === "undefined") return false;
  if (window.matchMedia("(pointer: coarse)").matches) return true;
  if (window.matchMedia("(hover: none)").matches) return true;
  return navigator.maxTouchPoints > 0;
}

export function usePrefersVirtualKeyboard() {
  const [enabled, setEnabled] = useState(detectTouchInput);

  useEffect(() => {
    const sync = () => setEnabled(detectTouchInput());
    const queries = ["(pointer: coarse)", "(hover: none)"].map((q) => window.matchMedia(q));
    queries.forEach((media) => media.addEventListener("change", sync));
    return () => queries.forEach((media) => media.removeEventListener("change", sync));
  }, []);

  return enabled;
}

export function applyVirtualKey(value, key, { shifted = false } = {}) {
  if (key === "backspace") return value.slice(0, -1);
  if (key === "space") return `${value} `;
  if (key.length === 1) {
    const char = shifted ? key.toUpperCase() : key;
    return value + char;
  }
  return value;
}

function labelForKey(key, { shifted, numbers }) {
  if (key === "shift") return shifted ? "⇧" : "⇧";
  if (key === "123") return numbers ? "ABC" : "123";
  if (key === "abc") return "ABC";
  if (key === "backspace") return null;
  if (key === "search") return null;
  if (key === "space") return "space";
  if (key.length === 1 && shifted && !numbers) return key.toUpperCase();
  return key;
}

export function VirtualKeyboard({ onKey, onSearch, disabled }) {
  const [shifted, setShifted] = useState(false);
  const [numbers, setNumbers] = useState(false);

  const rows = numbers ? NUMBER_ROWS : LETTER_ROWS;

  const press = useCallback(
    (key) => {
      if (disabled) return;
      if (key === "shift") {
        setShifted((current) => !current);
        return;
      }
      if (key === "123") {
        setNumbers(true);
        setShifted(false);
        return;
      }
      if (key === "abc") {
        setNumbers(false);
        setShifted(false);
        return;
      }
      if (key === "search") {
        onSearch?.();
        return;
      }
      onKey?.(key, { shifted: shifted && !numbers });
      if (shifted && key.length === 1) setShifted(false);
    },
    [disabled, onKey, onSearch, shifted, numbers]
  );

  return (
    <div className="virtualKeyboard" role="group" aria-label="On-screen keyboard">
      {rows.map((row, rowIndex) => (
        <div className="virtualKeyboardRow" key={`${numbers ? "n" : "l"}-${rowIndex}`}>
          {row.map((key) => {
            const wide = key === "space";
            const action = key === "search" || key === "backspace" || key === "shift" || key === "123" || key === "abc";
            const label = labelForKey(key, { shifted, numbers });
            const active = (key === "shift" && shifted) || (key === "123" && numbers) || (key === "abc" && !numbers);

            return (
              <button
                key={key}
                type="button"
                className={[
                  "vkKey",
                  wide && "vkKey--wide",
                  action && "vkKey--action",
                  key === "search" && "vkKey--search",
                  active && "vkKey--active"
                ].filter(Boolean).join(" ")}
                disabled={disabled}
                aria-label={
                  key === "backspace"
                    ? "Backspace"
                    : key === "search"
                      ? "Search"
                      : key === "space"
                        ? "Space"
                        : label
                }
                onPointerDown={(event) => {
                  event.preventDefault();
                  press(key);
                }}
              >
                {key === "backspace" ? <Delete size={17} strokeWidth={1.5} /> : null}
                {key === "search" ? (
                  <>
                    <span>search</span>
                    <CornerDownLeft size={17} strokeWidth={1.5} />
                  </>
                ) : null}
                {label && key !== "search" && key !== "backspace" ? <span>{label}</span> : null}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
