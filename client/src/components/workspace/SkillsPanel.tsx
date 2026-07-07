import { useEffect, useState } from 'react';
import { Wand2 } from 'lucide-react';

// Clean, professional flat icons via the open Iconify API (vscode-icons / logos / flat-color-icons).
const ICON_BASE = 'https://api.iconify.design/';

type Skill = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  icon: string; // iconify name, e.g. "vscode-icons:file-type-pdf2"
};

const DEFAULT_SKILLS: Skill[] = [
  { id: 'browser', name: 'Browser', description: 'Let Nalu open and control the in-app browser to run research tasks.', enabled: true, icon: 'logos:chrome' },
  { id: 'documents', name: 'Documents', description: 'Create and edit Word and Google Docs files.', enabled: true, icon: 'vscode-icons:file-type-word' },
  { id: 'image-gen', name: 'Image Gen', description: 'Generate or edit images for websites, games, and more.', enabled: true, icon: 'vscode-icons:file-type-image' },
  { id: 'nalu-docs', name: 'Nalu Docs', description: 'Reference docs, choose models, and explore the API.', enabled: true, icon: 'flat-color-icons:reading' },
  { id: 'pdf', name: 'PDF', description: 'Read, create, render, and verify PDF files.', enabled: true, icon: 'vscode-icons:file-type-pdf2' },
  { id: 'plugin-creator', name: 'Plugin Creator', description: 'Scaffold plugins and marketplace entries.', enabled: true, icon: 'flat-color-icons:puzzle' },
  { id: 'presentations', name: 'Presentations', description: 'Create polished PowerPoint and Google Slides decks.', enabled: true, icon: 'vscode-icons:file-type-powerpoint2' },
  { id: 'skill-creator', name: 'Skill Creator', description: 'Create or update a skill.', enabled: true, icon: 'flat-color-icons:edit-image' },
  { id: 'skill-installer', name: 'Skill Installer', description: 'Install curated skills from nalu/skills or other repos.', enabled: true, icon: 'flat-color-icons:download' },
  { id: 'spreadsheets', name: 'Spreadsheets', description: 'Create and edit spreadsheet or Google Sheets-ready files.', enabled: true, icon: 'vscode-icons:file-type-excel2' },
];

const STORAGE_KEY = 'nalu-skills';

function loadEnabledMap(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, boolean> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === 'boolean') out[key] = value;
      }
      return out;
    }
  } catch {
    // ignore malformed persisted state and fall back to defaults
  }
  return {};
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-400/40 ${
        checked ? 'border-emerald-400/40 bg-emerald-500/80' : 'border-glass/[0.18] bg-glass/10'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${
          checked ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  );
}

export default function SkillsPanel() {
  const [skills, setSkills] = useState<Skill[]>(() => {
    const map = loadEnabledMap();
    return DEFAULT_SKILLS.map((s) => (s.id in map ? { ...s, enabled: map[s.id] } : s));
  });

  useEffect(() => {
    try {
      const map: Record<string, boolean> = {};
      for (const s of skills) map[s.id] = s.enabled;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    } catch {
      // storage may be unavailable (private mode); ignore
    }
  }, [skills]);

  const toggle = (id: string) => {
    setSkills((prev) => prev.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)));
  };

  const enabledCount = skills.filter((s) => s.enabled).length;

  return (
    <div className="flex h-full flex-col bg-glass/[0.09] backdrop-blur-2xl font-sans text-ink">
      <header className="flex items-center gap-3 border-b border-glass/[0.18] px-6 py-4">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-glass/5">
          <Wand2 className="h-5 w-5 text-emerald-300" />
        </div>
        <div className="min-w-0">
          <h1 className="text-base font-semibold text-ink">Skills</h1>
          <p className="truncate text-sm text-dim">Give Nalu superpowers</p>
        </div>
        <span className="ml-auto rounded-full bg-glass/5 px-3 py-1 text-xs text-dim">
          {enabledCount} of {skills.length} on
        </span>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        <ul className="mx-auto flex max-w-2xl flex-col gap-2">
          {skills.map((skill) => (
            <li
              key={skill.id}
              className="flex items-center gap-4 rounded-xl border border-glass/[0.18] bg-glass/[0.11] backdrop-blur-2xl px-4 py-3 transition-colors hover:bg-glass/5"
            >
              <div
                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-glass/[0.06] ${
                  skill.enabled ? '' : 'opacity-40 grayscale'
                }`}
              >
                <img src={`${ICON_BASE}${skill.icon}.svg`} alt="" className="h-[22px] w-[22px]" loading="lazy" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-ink">{skill.name}</div>
                <div className="truncate text-sm text-dim">{skill.description}</div>
              </div>
              <Toggle checked={skill.enabled} onChange={() => toggle(skill.id)} label={`Toggle ${skill.name}`} />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
