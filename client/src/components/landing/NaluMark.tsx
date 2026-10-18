/** Nalu's existing wolf silhouette, also used by the playground character. */
export default function NaluMark({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="-8 22 151 131" fill="none" aria-hidden="true">
      <path className="nalu-mark-outline" d="M88 33 85 34 81 38 72 52 62 72 59 75 57 75 55 71 57 46 58 45 58 32 56 32 38 57 29 74 7 97 7 99 17 99 18 100 18 103 1 121 2 122 11 122 14 124 12 128 1 138 0 140 1 142 97 142 97 140 95 137 97 133 104 130 106 128 123 119 128 115 131 114 135 110 135 107 133 104 112 91 96 83 88 76 86 70 86 54 87 53Z" fill="currentColor" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" pathLength="1" />
    </svg>
  )
}
