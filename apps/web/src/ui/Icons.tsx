// Inline stroke icons (24×24).

import type { ReactNode } from 'react';

const Svg = ({ children, size = 22 }: { children: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const IconSelect = () => (
  <Svg>
    <path d="M5 3l14 8-6 1.5L10 19z" />
  </Svg>
);
export const IconRoad = () => (
  <Svg>
    <path d="M7 21L10 3M17 21L14 3M12 6v2M12 11v2M12 16v2" />
  </Svg>
);
export const IconBuilding = () => (
  <Svg>
    <path d="M4 21V9l6-4v16M10 21V3h10v18M3 21h18M13 7h4M13 11h4M13 15h4" />
  </Svg>
);
export const IconBulldoze = () => (
  <Svg>
    <path d="M3 17h11v-5H8L6 9H3zM14 14h3l4 3M5 20.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM12 20.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z" />
  </Svg>
);
export const IconBus = () => (
  <Svg>
    <rect x="4" y="3" width="16" height="15" rx="2" />
    <path d="M4 11h16M8 21v-3M16 21v-3M8 15h.01M16 15h.01" />
  </Svg>
);
export const IconClosure = () => (
  <Svg>
    <path d="M3 9h18v5H3zM6 9l4 5M12 9l4 5M18 9l3 4M6 14v6M18 14v6" />
  </Svg>
);
export const IconParcel = () => (
  <Svg>
    <path d="M4 5l8-2 8 3-1 13-9 2-6-4z" />
    <path d="M12 3l-1 18M5 12h14" strokeDasharray="2 2" />
  </Svg>
);
export const IconChart = () => (
  <Svg size={16}>
    <path d="M4 20V10M10 20V4M16 20v-7M3 20h18" />
  </Svg>
);
export const IconCity = ({ size = 20 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M3 21h18M5 21V10l4-2v13M9 21V5l6-2v18M15 21V9l4 2v10" />
  </Svg>
);
export const IconDownload = () => (
  <Svg size={16}>
    <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
  </Svg>
);
export const IconUpload = () => (
  <Svg size={16}>
    <path d="M12 20V9M7 14l5-5 5 5M5 4h14" />
  </Svg>
);
export const IconPause = () => (
  <Svg size={14}>
    <path d="M8 5v14M16 5v14" />
  </Svg>
);
