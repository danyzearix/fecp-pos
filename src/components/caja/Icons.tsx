type P = { className?: string };
const base = {
  width: 24,
  height: 24,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export const IconCart = ({ className }: P) => (
  <svg {...base} className={className}>
    <path d="M3 4h2l2.4 10.2a1 1 0 0 0 1 .8h8.2a1 1 0 0 0 1-.8L19 8H6" />
    <circle cx="9" cy="19" r="1.3" />
    <circle cx="17" cy="19" r="1.3" />
  </svg>
);
export const IconClock = ({ className }: P) => (
  <svg {...base} className={className}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);
export const IconBox = ({ className }: P) => (
  <svg {...base} className={className}>
    <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" />
    <path d="M4 7.5l8 4.5 8-4.5M12 12v9" />
  </svg>
);
export const IconBars = ({ className }: P) => (
  <svg {...base} className={className}>
    <path d="M5 20V10M12 20V4M19 20v-7" />
  </svg>
);
export const IconLogout = ({ className }: P) => (
  <svg {...base} className={className}>
    <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 8l-4 4 4 4M6 12h10" />
  </svg>
);
export const IconTrash = ({ className }: P) => (
  <svg {...base} className={className}>
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M9 7V4h6v3" />
  </svg>
);
export const IconSearch = ({ className }: P) => (
  <svg {...base} className={className}>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-4-4" />
  </svg>
);
