import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Box,
  Check,
  CheckCircle2,
  Copy,
  Download,
  Droplets,
  Eye,
  LayoutGrid,
  LineChart,
  Moon,
  Paintbrush,
  Palette,
  Pin,
  Plus,
  RotateCcw,
  Save,
  Sliders,
  Sparkles,
  Sun,
  Thermometer,
  Trash2,
  Type,
  Upload,
} from 'lucide-react';
import { CustomThemeRecord, ThemeFamily, ThemeId, UserSettings } from '../types';
import {
  applyThemeToDocument,
  cloneThemeAsDraft,
  deriveSwatches,
  hexToRgbTriplet,
  sanitizeThemeVars,
  setCustomThemes,
  THEMES,
  ThemeDefinition,
} from '../utils/themes';
import { WindowTopBar } from './WindowTopBar';

type EditorTab = 'colors' | 'fonts' | 'borders' | 'spacing';

interface ColorFieldDef {
  key: string;
  label: string;
  hint?: string;
}

const COLOR_SECTIONS: Array<{ title: string; fields: ColorFieldDef[] }> = [
  {
    title: 'Backgrounds & Surfaces',
    fields: [
      { key: '--bg-base', label: 'Base Canvas', hint: 'Main background hex' },
      { key: '--bg-shell', label: 'Shell Gradient / Fill', hint: 'Color or radial/linear gradient' },
      { key: '--bg-header', label: 'Title Bar & Header', hint: 'Top window bar & header' },
      { key: '--bg-surface', label: 'Inner Surface', hint: 'Sensor rows & filter wells' },
      { key: '--bg-card', label: 'Card Background', hint: 'Module & settings cards' },
      { key: '--bg-card-hover', label: 'Card Hover', hint: 'Hover elevation background' },
      { key: '--bg-elevated', label: 'Elevated Controls', hint: 'Inputs, buttons & badges' },
      { key: '--bg-input', label: 'Input Field Fill', hint: 'Text boxes & dropdowns' },
    ],
  },
  {
    title: 'Typography & Accents',
    fields: [
      { key: '--text-primary', label: 'Primary Text' },
      { key: '--text-secondary', label: 'Secondary Text' },
      { key: '--text-muted', label: 'Muted / Meta Text' },
      { key: '--accent-sky', label: 'Primary Accent', hint: 'Active tabs, highlights & links' },
      { key: '--accent-blue', label: 'Secondary Accent', hint: 'Gradients & buttons' },
      { key: '--accent-emerald', label: 'Emerald / Good', hint: 'Online status & healthy CO₂' },
      { key: '--accent-amber', label: 'Amber / Warning' },
      { key: '--accent-rose', label: 'Rose / Alert' },
    ],
  },
  {
    title: 'Charts & Floating Widget',
    fields: [
      { key: '--chart-grid', label: 'Chart Gridlines' },
      { key: '--chart-axis', label: 'Chart Axis Labels' },
      { key: '--chart-crosshair', label: 'Chart Crosshair' },
      { key: '--widget-pill-bg', label: 'Widget Sensor Pill' },
    ],
  },
];

const APP_FONT_PRESETS: Array<{ label: string; value: string }> = [
  {
    label: 'Segoe UI Variable (Modern Windows)',
    value: "'Segoe UI Variable Display', 'Segoe UI', -apple-system, sans-serif",
  },
  {
    label: 'Segoe UI Standard',
    value: "'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif",
  },
  {
    label: 'Cascadia Code / Monospace',
    value: "'Cascadia Code', 'Cascadia Mono', 'Consolas', monospace",
  },
  {
    label: 'Consolas Technical',
    value: "'Consolas', 'Cascadia Mono', monospace",
  },
  {
    label: 'Quicksand / Soft Rounded',
    value: "'Quicksand', 'Nunito', 'Segoe UI Rounded', 'Segoe UI', sans-serif",
  },
  {
    label: 'Inter / Clean Sans',
    value: "'Inter', 'Segoe UI', system-ui, sans-serif",
  },
  {
    label: 'Georgia Editorial Serif',
    value: "'Georgia', 'Cambria', serif",
  },
];

const MONO_FONT_PRESETS: Array<{ label: string; value: string }> = [
  { label: 'Cascadia Code / Consolas', value: "'Cascadia Code', 'Consolas', monospace" },
  { label: 'Cascadia Mono', value: "'Cascadia Mono', 'Consolas', monospace" },
  { label: 'Consolas', value: "'Consolas', 'Courier New', monospace" },
  { label: 'JetBrains Mono / Fira Code', value: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace" },
];

const FAMILY_OPTIONS: Array<{ value: ThemeFamily; label: string }> = [
  { value: 'custom', label: 'Custom Theme (Free styling)' },
  { value: 'fluent', label: 'Modern Fluent' },
  { value: 'nord', label: 'Nordic Minimalist' },
  { value: 'compact', label: 'Compact Density' },
  { value: 'terminal', label: 'Cyber Terminal' },
  { value: 'brutal', label: 'Neo-Brutalist' },
  { value: 'soft', label: 'Soft Organic' },
];

function parsePxNumber(val: string | undefined, fallback: number): number {
  if (!val) return fallback;
  const parsed = parseFloat(val);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toPickerHex(raw: string | undefined, fallback = '#38bdf8'): string {
  if (!raw || typeof raw !== 'string') return fallback;
  const s = raw.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s;
  const hex3 = /^#([0-9a-fA-F]{3})$/.exec(s);
  if (hex3) {
    return `#${hex3[1][0]}${hex3[1][0]}${hex3[1][1]}${hex3[1][1]}${hex3[1][2]}${hex3[1][2]}`;
  }
  const rgbMatch = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i.exec(s);
  if (rgbMatch) {
    const h = (n: string) =>
      Math.max(0, Math.min(255, Number(n) || 0))
        .toString(16)
        .padStart(2, '0');
    return `#${h(rgbMatch[1])}${h(rgbMatch[2])}${h(rgbMatch[3])}`;
  }
  return fallback;
}

export const ThemeEditorWindow: React.FC = () => {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [customThemesList, setCustomThemesList] = useState<CustomThemeRecord[]>([]);
  const [draft, setDraft] = useState<CustomThemeRecord>(() =>
    cloneThemeAsDraft(THEMES[0], [])
  );
  const [inspectingBuiltInId, setInspectingBuiltInId] = useState<string | null>(null);
  const [editorTab, setEditorTab] = useState<EditorTab>('colors');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{
    tone: 'ok' | 'err' | 'info';
    text: string;
  } | null>(null);

  const loadThemeIntoEditor = useCallback(
    (targetId: string | undefined, customList: CustomThemeRecord[]) => {
      if (targetId) {
        const customMatch = customList.find((c) => c.id === targetId);
        if (customMatch) {
          setInspectingBuiltInId(null);
          setDraft({
            ...customMatch,
            vars: {
              '--window-border-width': '0px',
              '--window-border-color':
                customMatch.vars['--border-strong'] || '#38bdf8',
              ...customMatch.vars,
            },
          });
          return;
        }
        const builtIn = THEMES.find((t) => t.id === targetId);
        if (builtIn) {
          setInspectingBuiltInId(builtIn.id);
          setDraft(
            cloneThemeAsDraft(
              builtIn,
              customList.map((c) => c.name)
            )
          );
          return;
        }
      }

      if (customList.length > 0) {
        setInspectingBuiltInId(null);
        setDraft({
          ...customList[0],
          vars: {
            '--window-border-width': '0px',
            '--window-border-color':
              customList[0].vars['--border-strong'] || '#38bdf8',
            ...customList[0].vars,
          },
        });
      } else {
        setInspectingBuiltInId(THEMES[0].id);
        setDraft(cloneThemeAsDraft(THEMES[0], []));
      }
    },
    []
  );

  useEffect(() => {
    let mounted = true;
    const init = async () => {
      const [s, customList] = await Promise.all([
        window.winatmo.getSettings(),
        window.winatmo.getCustomThemes?.().catch(() => []),
      ]);
      if (!mounted) return;
      const list = Array.isArray(customList) ? customList : [];
      setCustomThemes(list);
      setCustomThemesList(list);
      setSettings(s);

      const paramTheme =
        typeof window !== 'undefined'
          ? new URLSearchParams(window.location.search).get('theme') || undefined
          : undefined;
      loadThemeIntoEditor(paramTheme || s?.theme, list);
    };
    init();

    const unsubSettings = window.winatmo.onSettingsUpdated((next) => {
      setSettings(next);
    });
    const unsubCustom = window.winatmo.onCustomThemesUpdated?.((themes) => {
      setCustomThemes(themes);
      setCustomThemesList(themes);
      setSettings((prev) => (prev ? { ...prev } : prev));
    });
    const unsubSelect = window.winatmo.onThemeEditorSelect?.((themeId) => {
      window.winatmo
        .getCustomThemes?.()
        .then((latest) => {
          const list = Array.isArray(latest) ? latest : [];
          setCustomThemes(list);
          setCustomThemesList(list);
          loadThemeIntoEditor(themeId, list);
        })
        .catch(() => {});
    });

    return () => {
      mounted = false;
      unsubSettings();
      unsubCustom?.();
      unsubSelect?.();
    };
  }, [loadThemeIntoEditor]);

  useEffect(() => {
    if (settings?.theme) {
      applyThemeToDocument(settings.theme);
    }
  }, [settings?.theme, customThemesList]);

  const isSavedCustom = useMemo(
    () =>
      !inspectingBuiltInId &&
      customThemesList.some((c) => c.id === draft.id),
    [inspectingBuiltInId, customThemesList, draft.id]
  );

  const ensureEditableDraft = (current: CustomThemeRecord): CustomThemeRecord => {
    if (!inspectingBuiltInId) return current;
    setInspectingBuiltInId(null);
    return current;
  };

  const updateDraftField = <K extends keyof CustomThemeRecord>(
    field: K,
    value: CustomThemeRecord[K]
  ) => {
    setDraft((prev) => {
      const base = ensureEditableDraft(prev);
      return {
        ...base,
        [field]: value,
      };
    });
  };

  const updateVar = (key: string, value: string) => {
    setDraft((prev) => {
      const base = ensureEditableDraft(prev);
      const nextVars = { ...base.vars, [key]: value };
      const radius = nextVars['--radius-md'] || '14px';
      const fontSize = nextVars['--font-size-base'] || '13px';
      const wbWidth = parsePxNumber(nextVars['--window-border-width'], 0);
      const borderLabel = wbWidth > 0 ? ` • ${wbWidth}px Window Border` : '';
      return {
        ...base,
        vars: nextVars,
        swatches: deriveSwatches(nextVars, base.mode),
        styleLabel: `${radius} Radius • ${fontSize} Font${borderLabel}`,
      };
    });
  };

  const handleNewTheme = () => {
    setInspectingBuiltInId(null);
    const fresh = cloneThemeAsDraft(
      THEMES[0],
      customThemesList.map((c) => c.name)
    );
    fresh.name = `Custom Theme ${customThemesList.length + 1}`;
    fresh.subtitle = 'Created in winAtmo Theme Editor';
    setDraft(fresh);
    setNotice({ tone: 'info', text: 'Started a fresh theme draft.' });
  };

  const handleCloneTheme = (source: ThemeDefinition | CustomThemeRecord) => {
    setInspectingBuiltInId(null);
    const cloned = cloneThemeAsDraft(
      source,
      customThemesList.map((c) => c.name)
    );
    setDraft(cloned);
    setNotice({
      tone: 'info',
      text: `Cloned "${source.name}" into new editable theme "${cloned.name}".`,
    });
  };

  const handleSelectCustom = (theme: CustomThemeRecord) => {
    setInspectingBuiltInId(null);
    setDraft({
      ...theme,
      vars: {
        '--window-border-width': '0px',
        '--window-border-color': theme.vars['--border-strong'] || '#38bdf8',
        ...theme.vars,
      },
    });
    setNotice(null);
  };

  const handleSelectBuiltIn = (theme: ThemeDefinition) => {
    setInspectingBuiltInId(theme.id);
    setDraft(
      cloneThemeAsDraft(
        theme,
        customThemesList.map((c) => c.name)
      )
    );
    setNotice(null);
  };

  const handleSave = async (applyAfterSave = false) => {
    setBusy(true);
    setNotice(null);
    try {
      const cleanName = draft.name.trim() || 'Untitled Custom Theme';
      const cleanVars = sanitizeThemeVars(draft.vars);
      const radius = cleanVars['--radius-md'] || '14px';
      const fontSize = cleanVars['--font-size-base'] || '13px';
      const wbWidth = parsePxNumber(cleanVars['--window-border-width'], 0);
      const borderLabel = wbWidth > 0 ? ` • ${wbWidth}px Window Border` : '';

      const toSave: CustomThemeRecord = {
        ...draft,
        name: cleanName,
        family: inspectingBuiltInId ? 'custom' : draft.family,
        familyTitle: 'Custom Theme',
        styleLabel: `${radius} Radius • ${fontSize} Font${borderLabel}`,
        swatches: deriveSwatches(cleanVars, draft.mode),
        vars: cleanVars,
        isCustom: true,
      };

      const res = await window.winatmo.saveCustomTheme(toSave);
      if (!res.ok || !res.theme) {
        setNotice({
          tone: 'err',
          text: res.error || 'Failed to save custom theme.',
        });
        return;
      }

      setInspectingBuiltInId(null);
      setCustomThemes(res.themes);
      setCustomThemesList(res.themes);
      setDraft(res.theme);

      if (applyAfterSave) {
        await window.winatmo.updateSettings({ theme: res.theme.id as ThemeId });
        setNotice({
          tone: 'ok',
          text: `Saved and applied "${res.theme.name}" across all windows.`,
        });
      } else {
        setNotice({
          tone: 'ok',
          text: `Saved "${res.theme.name}" to the database.`,
        });
      }
    } catch (err: any) {
      setNotice({
        tone: 'err',
        text: err?.message || 'Unexpected error while saving theme.',
      });
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (themeId: string, themeName: string) => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await window.winatmo.deleteCustomTheme(themeId);
      if (!res.ok) {
        setNotice({ tone: 'err', text: res.error || 'Failed to delete theme.' });
        return;
      }
      setCustomThemes(res.themes);
      setCustomThemesList(res.themes);
      if (draft.id === themeId) {
        loadThemeIntoEditor(undefined, res.themes);
      }
      setNotice({ tone: 'ok', text: `Deleted custom theme "${themeName}".` });
    } catch (err: any) {
      setNotice({
        tone: 'err',
        text: err?.message || 'Failed to delete custom theme.',
      });
    } finally {
      setBusy(false);
    }
  };

  const handleExport = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await window.winatmo.exportCustomTheme(draft);
      if (res.canceled) return;
      if (res.success) {
        setNotice({
          tone: 'ok',
          text: `Exported "${draft.name}" to ${res.filePath}`,
        });
      } else {
        setNotice({
          tone: 'err',
          text: res.error || 'Export failed.',
        });
      }
    } catch (err: any) {
      setNotice({ tone: 'err', text: err?.message || 'Export failed.' });
    } finally {
      setBusy(false);
    }
  };

  const handleImport = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await window.winatmo.importCustomTheme();
      if (res.canceled) return;
      if (res.success && res.theme) {
        const list = res.themes || [];
        setInspectingBuiltInId(null);
        setCustomThemes(list);
        setCustomThemesList(list);
        setDraft(res.theme);
        setNotice({
          tone: 'ok',
          text: `Imported "${res.theme.name}" and saved it to the database.`,
        });
      } else {
        setNotice({
          tone: 'err',
          text: res.error || 'Could not import theme file.',
        });
      }
    } catch (err: any) {
      setNotice({
        tone: 'err',
        text: err?.message || 'Could not import theme file.',
      });
    } finally {
      setBusy(false);
    }
  };

  const previewCssVars = useMemo(() => {
    const styleObj: Record<string, string> = {
      ...draft.vars,
      '--widget-bg-rgb': draft.widgetBgRgb || '13, 19, 33',
    };
    return styleObj as React.CSSProperties;
  }, [draft]);

  const winBorderW = parsePxNumber(draft.vars['--window-border-width'], 0);
  const borderW = parsePxNumber(draft.vars['--border-width'], 1);
  const radMd = parsePxNumber(draft.vars['--radius-md'], 14);
  const radSm = parsePxNumber(draft.vars['--radius-sm'], 8);
  const radXs = parsePxNumber(draft.vars['--radius-xs'], 4);
  const radPill = parsePxNumber(draft.vars['--radius-pill'], 999);
  const fontBase = parsePxNumber(draft.vars['--font-size-base'], 13);
  const fontSm = parsePxNumber(draft.vars['--font-size-sm'], 11.5);
  const fontMetric = parsePxNumber(draft.vars['--font-size-metric'], 16);
  const fontCardTitle = parsePxNumber(draft.vars['--font-size-card-title'], 15.5);
  const fontSectionTitle = parsePxNumber(draft.vars['--font-size-section-title'], 18);
  const cardGap = parsePxNumber(draft.vars['--space-card-gap'], 16);
  const metricGap = parsePxNumber(draft.vars['--space-metric-gap'], 8);
  const iconSize = parsePxNumber(draft.vars['--metric-icon-size'], 30);

  return (
    <div
      className={`app-shell theme-${settings?.theme || 'fluent-dark'} platform-${
        window.winatmo?.platform || 'win32'
      }`}
    >
      <WindowTopBar
        title="winAtmo"
        subtitle="Theme Editor"
        currentTheme={settings?.theme}
        onThemeChange={(theme) => window.winatmo.updateSettings({ theme })}
      />

      <div className="theme-editor-shell">
        {/* Left Sidebar: Custom & Preinstalled Theme Library */}
        <aside className="theme-editor-sidebar">
          <div className="theme-editor-sidebar-actions">
            <button
              type="button"
              className="action-btn primary"
              onClick={handleNewTheme}
              disabled={busy}
            >
              <Plus size={14} /> New Theme
            </button>
            <button
              type="button"
              className="action-btn"
              onClick={handleImport}
              disabled={busy}
            >
              <Upload size={14} /> Import
            </button>
          </div>

          <div className="theme-editor-library-scroll">
            <div className="theme-library-group">
              <div className="theme-library-group-title">
                <span>Custom Themes ({customThemesList.length})</span>
              </div>
              {customThemesList.length === 0 ? (
                <div className="theme-library-empty">
                  No custom themes yet. Click <strong>New Theme</strong> or clone any preinstalled preset below.
                </div>
              ) : (
                customThemesList.map((item) => {
                  const isSelected = !inspectingBuiltInId && draft.id === item.id;
                  const isActiveApp = settings?.theme === item.id;
                  return (
                    <div
                      key={item.id}
                      className={`theme-library-item${isSelected ? ' selected' : ''}`}
                      onClick={() => handleSelectCustom(item)}
                    >
                      <div className="theme-library-item-main">
                        <div className="theme-library-item-top">
                          {item.mode === 'light' ? <Sun size={11} /> : <Moon size={11} />}
                          <span className="theme-library-item-name">{item.name}</span>
                          {isActiveApp && <span className="theme-library-active-tag">Active</span>}
                        </div>
                        <div className="theme-library-swatches">
                          {item.swatches.map((hex, i) => (
                            <span
                              key={i}
                              className="theme-swatch-dot"
                              style={{ backgroundColor: hex }}
                            />
                          ))}
                        </div>
                      </div>
                      <div className="theme-library-item-btns">
                        <button
                          type="button"
                          className="icon-action-btn"
                          title={`Clone ${item.name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCloneTheme(item);
                          }}
                        >
                          <Copy size={12} />
                        </button>
                        <button
                          type="button"
                          className="icon-action-btn"
                          title={`Delete ${item.name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(item.id, item.name);
                          }}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <div className="theme-library-group">
              <div className="theme-library-group-title">
                <span>Preinstalled Themes ({THEMES.length})</span>
              </div>
              {THEMES.map((item) => {
                const isSelected = inspectingBuiltInId === item.id;
                const isActiveApp = settings?.theme === item.id;
                return (
                  <div
                    key={item.id}
                    className={`theme-library-item${isSelected ? ' selected' : ''}`}
                    onClick={() => handleSelectBuiltIn(item)}
                  >
                    <div className="theme-library-item-main">
                      <div className="theme-library-item-top">
                        {item.mode === 'light' ? <Sun size={11} /> : <Moon size={11} />}
                        <span className="theme-library-item-name">{item.name}</span>
                        {isActiveApp && <span className="theme-library-active-tag">Active</span>}
                      </div>
                      <div className="theme-library-swatches">
                        {item.swatches.map((hex, i) => (
                          <span
                            key={i}
                            className="theme-swatch-dot"
                            style={{ backgroundColor: hex }}
                          />
                        ))}
                      </div>
                    </div>
                    <div className="theme-library-item-btns">
                      <button
                        type="button"
                        className="icon-action-btn"
                        title={`Clone ${item.name} to new custom theme`}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleCloneTheme(item);
                        }}
                      >
                        <Copy size={12} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </aside>

        {/* Center Pane: Properties Editor */}
        <section className="theme-editor-controls">
          <div className="theme-editor-meta-card">
            <div className="theme-editor-meta-grid">
              <div className="setting-field">
                <label>Theme Name</label>
                <input
                  type="text"
                  className="text-input"
                  value={draft.name}
                  maxLength={60}
                  onChange={(e) => updateDraftField('name', e.target.value)}
                  placeholder="My Custom Theme"
                />
              </div>
              <div className="setting-field">
                <label>Subtitle / Description</label>
                <input
                  type="text"
                  className="text-input"
                  value={draft.subtitle}
                  maxLength={140}
                  onChange={(e) => updateDraftField('subtitle', e.target.value)}
                  placeholder="Short description shown in Settings"
                />
              </div>
              <div className="setting-field">
                <label>Base Appearance</label>
                <div className="pill-group">
                  <button
                    type="button"
                    className={`pill-btn${draft.mode === 'dark' ? ' active' : ''}`}
                    onClick={() => {
                      const prevBase = ensureEditableDraft(draft);
                      setDraft({
                        ...prevBase,
                        mode: 'dark',
                        swatches: deriveSwatches(prevBase.vars, 'dark'),
                      });
                    }}
                  >
                    <Moon size={12} /> Dark
                  </button>
                  <button
                    type="button"
                    className={`pill-btn${draft.mode === 'light' ? ' active' : ''}`}
                    onClick={() => {
                      const prevBase = ensureEditableDraft(draft);
                      setDraft({
                        ...prevBase,
                        mode: 'light',
                        swatches: deriveSwatches(prevBase.vars, 'light'),
                      });
                    }}
                  >
                    <Sun size={12} /> Light
                  </button>
                </div>
              </div>
              <div className="setting-field">
                <label>Base Style Family</label>
                <select
                  className="select-input"
                  value={draft.family}
                  onChange={(e) =>
                    updateDraftField('family', e.target.value as ThemeFamily)
                  }
                >
                  {FAMILY_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {inspectingBuiltInId && (
              <div className="theme-editor-template-banner">
                <span>
                  Inspecting preinstalled preset <strong>{THEMES.find((t) => t.id === inspectingBuiltInId)?.name}</strong>. Editing any property or clicking Clone creates a new editable custom theme.
                </span>
                <button
                  type="button"
                  className="pill-btn active"
                  onClick={() => {
                    const src = THEMES.find((t) => t.id === inspectingBuiltInId);
                    if (src) handleCloneTheme(src);
                  }}
                >
                  <Copy size={12} /> Clone Preset Now
                </button>
              </div>
            )}

            <div className="theme-editor-action-row">
              <button
                type="button"
                className="action-btn primary"
                disabled={busy}
                onClick={() => handleSave(true)}
              >
                <CheckCircle2 size={14} /> Save &amp; Apply
              </button>
              <button
                type="button"
                className="action-btn"
                disabled={busy}
                onClick={() => handleSave(false)}
              >
                <Save size={14} /> Save
              </button>
              <button
                type="button"
                className="action-btn"
                disabled={busy}
                onClick={() => handleCloneTheme(draft)}
              >
                <Copy size={14} /> Clone Draft
              </button>
              <button
                type="button"
                className="action-btn"
                disabled={busy}
                onClick={handleExport}
              >
                <Download size={14} /> Export JSON
              </button>
              {isSavedCustom && (
                <button
                  type="button"
                  className="action-btn danger"
                  disabled={busy}
                  onClick={() => handleDelete(draft.id, draft.name)}
                >
                  <Trash2 size={14} /> Delete
                </button>
              )}
            </div>

            {notice && (
              <div className={`theme-editor-notice ${notice.tone}`}>
                {notice.text}
              </div>
            )}
          </div>

          {/* Category Subtabs */}
          <div className="theme-editor-subtabs">
            <button
              type="button"
              className={`pill-btn${editorTab === 'colors' ? ' active' : ''}`}
              onClick={() => setEditorTab('colors')}
            >
              <Palette size={13} /> Colors
            </button>
            <button
              type="button"
              className={`pill-btn${editorTab === 'fonts' ? ' active' : ''}`}
              onClick={() => setEditorTab('fonts')}
            >
              <Type size={13} /> Fonts &amp; Typography
            </button>
            <button
              type="button"
              className={`pill-btn${editorTab === 'borders' ? ' active' : ''}`}
              onClick={() => setEditorTab('borders')}
            >
              <Box size={13} /> Window &amp; Borders
            </button>
            <button
              type="button"
              className={`pill-btn${editorTab === 'spacing' ? ' active' : ''}`}
              onClick={() => setEditorTab('spacing')}
            >
              <Sliders size={13} /> Spacing &amp; Density
            </button>
          </div>

          <div className="theme-editor-fields-scroll">
            {editorTab === 'colors' && (
              <>
                {COLOR_SECTIONS.map((sec) => (
                  <div key={sec.title} className="theme-editor-group-card">
                    <h4>{sec.title}</h4>
                    <div className="theme-color-fields-grid">
                      {sec.fields.map((field) => {
                        const rawVal = draft.vars[field.key] || '';
                        const pickerHex = toPickerHex(
                          rawVal,
                          draft.mode === 'light' ? '#ffffff' : '#0f172a'
                        );
                        return (
                          <div key={field.key} className="theme-color-field">
                            <div className="theme-color-field-label">
                              <span>{field.label}</span>
                              {field.hint && <small>{field.hint}</small>}
                            </div>
                            <div className="theme-color-input-pair">
                              <input
                                type="color"
                                className="theme-color-picker"
                                value={pickerHex}
                                onChange={(e) => updateVar(field.key, e.target.value)}
                                title={`Pick ${field.label}`}
                              />
                              <input
                                type="text"
                                className="text-input theme-color-text"
                                value={rawVal}
                                onChange={(e) => updateVar(field.key, e.target.value)}
                                placeholder="#rrggbb or rgba(...)"
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}

                <div className="theme-editor-group-card">
                  <h4>Floating Widget Translucent Base (RGB)</h4>
                  <div className="theme-inline-row">
                    <input
                      type="text"
                      className="text-input"
                      value={draft.widgetBgRgb}
                      onChange={(e) =>
                        updateDraftField('widgetBgRgb', e.target.value)
                      }
                      placeholder="13, 19, 33"
                    />
                    <button
                      type="button"
                      className="pill-btn"
                      onClick={() =>
                        updateDraftField(
                          'widgetBgRgb',
                          hexToRgbTriplet(draft.vars['--bg-base'] || '', '13, 19, 33')
                        )
                      }
                    >
                      <RotateCcw size={12} /> Sync from Base Color
                    </button>
                  </div>
                </div>
              </>
            )}

            {editorTab === 'fonts' && (
              <>
                <div className="theme-editor-group-card">
                  <h4>Font Families</h4>
                  <div className="theme-font-stack">
                    <div className="setting-field">
                      <label>Application Font Family Presets</label>
                      <select
                        className="select-input"
                        value={
                          APP_FONT_PRESETS.some(
                            (p) => p.value === draft.vars['--font-family-app']
                          )
                            ? draft.vars['--font-family-app']
                            : ''
                        }
                        onChange={(e) => {
                          if (e.target.value) updateVar('--font-family-app', e.target.value);
                        }}
                      >
                        <option value="">Custom font-family string...</option>
                        {APP_FONT_PRESETS.map((p) => (
                          <option key={p.label} value={p.value}>
                            {p.label}
                          </option>
                        ))}
                      </select>
                      <input
                        type="text"
                        className="text-input"
                        value={draft.vars['--font-family-app'] || ''}
                        onChange={(e) => updateVar('--font-family-app', e.target.value)}
                      />
                    </div>

                    <div className="setting-field">
                      <label>Monospace Font Family</label>
                      <select
                        className="select-input"
                        value={
                          MONO_FONT_PRESETS.some(
                            (p) => p.value === draft.vars['--font-family-mono']
                          )
                            ? draft.vars['--font-family-mono']
                            : ''
                        }
                        onChange={(e) => {
                          if (e.target.value) updateVar('--font-family-mono', e.target.value);
                        }}
                      >
                        <option value="">Custom monospace string...</option>
                        {MONO_FONT_PRESETS.map((p) => (
                          <option key={p.label} value={p.value}>
                            {p.label}
                          </option>
                        ))}
                      </select>
                      <input
                        type="text"
                        className="text-input"
                        value={draft.vars['--font-family-mono'] || ''}
                        onChange={(e) => updateVar('--font-family-mono', e.target.value)}
                      />
                    </div>
                  </div>
                </div>

                <div className="theme-editor-group-card">
                  <h4>Font Sizes &amp; Title Formatting</h4>
                  <div className="theme-sliders-grid">
                    <div className="theme-slider-row">
                      <div className="theme-slider-head">
                        <span>Base Text Size</span>
                        <strong>{fontBase}px</strong>
                      </div>
                      <input
                        type="range"
                        min={10}
                        max={16}
                        step={0.5}
                        value={fontBase}
                        onChange={(e) => updateVar('--font-size-base', `${e.target.value}px`)}
                      />
                    </div>
                    <div className="theme-slider-row">
                      <div className="theme-slider-head">
                        <span>Small / Label Size</span>
                        <strong>{fontSm}px</strong>
                      </div>
                      <input
                        type="range"
                        min={8.5}
                        max={14}
                        step={0.5}
                        value={fontSm}
                        onChange={(e) => updateVar('--font-size-sm', `${e.target.value}px`)}
                      />
                    </div>
                    <div className="theme-slider-row">
                      <div className="theme-slider-head">
                        <span>Metric Value Size</span>
                        <strong>{fontMetric}px</strong>
                      </div>
                      <input
                        type="range"
                        min={12}
                        max={22}
                        step={0.5}
                        value={fontMetric}
                        onChange={(e) => updateVar('--font-size-metric', `${e.target.value}px`)}
                      />
                    </div>
                    <div className="theme-slider-row">
                      <div className="theme-slider-head">
                        <span>Card Title Size</span>
                        <strong>{fontCardTitle}px</strong>
                      </div>
                      <input
                        type="range"
                        min={12}
                        max={20}
                        step={0.5}
                        value={fontCardTitle}
                        onChange={(e) =>
                          updateVar('--font-size-card-title', `${e.target.value}px`)
                        }
                      />
                    </div>
                    <div className="theme-slider-row">
                      <div className="theme-slider-head">
                        <span>Section Title Size</span>
                        <strong>{fontSectionTitle}px</strong>
                      </div>
                      <input
                        type="range"
                        min={13}
                        max={24}
                        step={0.5}
                        value={fontSectionTitle}
                        onChange={(e) =>
                          updateVar('--font-size-section-title', `${e.target.value}px`)
                        }
                      />
                    </div>
                    <div className="setting-field">
                      <label>Title Text Transform</label>
                      <select
                        className="select-input"
                        value={draft.vars['--text-transform-titles'] || 'none'}
                        onChange={(e) =>
                          updateVar('--text-transform-titles', e.target.value)
                        }
                      >
                        <option value="none">Normal (none)</option>
                        <option value="uppercase">UPPERCASE</option>
                        <option value="capitalize">Capitalize Words</option>
                      </select>
                    </div>
                    <div className="setting-field">
                      <label>Title Letter Spacing</label>
                      <select
                        className="select-input"
                        value={draft.vars['--letter-spacing'] || 'normal'}
                        onChange={(e) => updateVar('--letter-spacing', e.target.value)}
                      >
                        <option value="-0.02em">Tight (-0.02em)</option>
                        <option value="-0.01em">Slightly Tight (-0.01em)</option>
                        <option value="normal">Normal</option>
                        <option value="0.03em">Wide (0.03em)</option>
                        <option value="0.06em">Terminal Wide (0.06em)</option>
                      </select>
                    </div>
                  </div>
                </div>
              </>
            )}

            {editorTab === 'borders' && (
              <>
                <div className="theme-editor-group-card">
                  <h4>App Window Border Frame</h4>
                  <div className="theme-sliders-grid">
                    <div className="theme-slider-row">
                      <div className="theme-slider-head">
                        <span>Window Border Thickness</span>
                        <strong>{winBorderW}px</strong>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={6}
                        step={1}
                        value={winBorderW}
                        onChange={(e) =>
                          updateVar('--window-border-width', `${e.target.value}px`)
                        }
                      />
                    </div>
                    <div className="theme-color-field">
                      <div className="theme-color-field-label">
                        <span>Window Border Color</span>
                        <small>Visible around all main app windows</small>
                      </div>
                      <div className="theme-color-input-pair">
                        <input
                          type="color"
                          className="theme-color-picker"
                          value={toPickerHex(draft.vars['--window-border-color'], '#38bdf8')}
                          onChange={(e) =>
                            updateVar('--window-border-color', e.target.value)
                          }
                        />
                        <input
                          type="text"
                          className="text-input theme-color-text"
                          value={draft.vars['--window-border-color'] || ''}
                          onChange={(e) =>
                            updateVar('--window-border-color', e.target.value)
                          }
                        />
                      </div>
                    </div>
                  </div>
                </div>

                <div className="theme-editor-group-card">
                  <h4>Card &amp; Control Borders</h4>
                  <div className="theme-sliders-grid">
                    <div className="theme-slider-row">
                      <div className="theme-slider-head">
                        <span>Element Border Width</span>
                        <strong>{borderW}px</strong>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={4}
                        step={0.5}
                        value={borderW}
                        onChange={(e) => updateVar('--border-width', `${e.target.value}px`)}
                      />
                    </div>
                    <div className="theme-color-field">
                      <div className="theme-color-field-label">
                        <span>Subtle Border Color</span>
                      </div>
                      <div className="theme-color-input-pair">
                        <input
                          type="color"
                          className="theme-color-picker"
                          value={toPickerHex(draft.vars['--border-subtle'], '#334155')}
                          onChange={(e) => updateVar('--border-subtle', e.target.value)}
                        />
                        <input
                          type="text"
                          className="text-input theme-color-text"
                          value={draft.vars['--border-subtle'] || ''}
                          onChange={(e) => updateVar('--border-subtle', e.target.value)}
                        />
                      </div>
                    </div>
                    <div className="theme-color-field">
                      <div className="theme-color-field-label">
                        <span>Strong / Active Border</span>
                      </div>
                      <div className="theme-color-input-pair">
                        <input
                          type="color"
                          className="theme-color-picker"
                          value={toPickerHex(draft.vars['--border-strong'], '#38bdf8')}
                          onChange={(e) => updateVar('--border-strong', e.target.value)}
                        />
                        <input
                          type="text"
                          className="text-input theme-color-text"
                          value={draft.vars['--border-strong'] || ''}
                          onChange={(e) => updateVar('--border-strong', e.target.value)}
                        />
                      </div>
                    </div>
                  </div>
                </div>

                <div className="theme-editor-group-card">
                  <h4>Corner Rounding (Border Radius)</h4>
                  <div className="theme-sliders-grid">
                    <div className="theme-slider-row">
                      <div className="theme-slider-head">
                        <span>Card Radius (--radius-md)</span>
                        <strong>{radMd}px</strong>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={24}
                        step={1}
                        value={radMd}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          updateVar('--radius-md', `${v}px`);
                          updateVar('--radius-lg', `${Math.min(28, v + 4)}px`);
                        }}
                      />
                    </div>
                    <div className="theme-slider-row">
                      <div className="theme-slider-head">
                        <span>Sub-Panel &amp; Button Radius (--radius-sm)</span>
                        <strong>{radSm}px</strong>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={16}
                        step={1}
                        value={radSm}
                        onChange={(e) => updateVar('--radius-sm', `${e.target.value}px`)}
                      />
                    </div>
                    <div className="theme-slider-row">
                      <div className="theme-slider-head">
                        <span>Badge / Icon Radius (--radius-xs)</span>
                        <strong>{radXs}px</strong>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={12}
                        step={1}
                        value={radXs}
                        onChange={(e) => updateVar('--radius-xs', `${e.target.value}px`)}
                      />
                    </div>
                    <div className="theme-slider-row">
                      <div className="theme-slider-head">
                        <span>Pill Rounding (--radius-pill)</span>
                        <strong>{radPill >= 900 ? '999px (Full)' : `${radPill}px`}</strong>
                      </div>
                      <div className="theme-inline-row">
                        <input
                          type="range"
                          min={0}
                          max={24}
                          step={1}
                          value={Math.min(24, radPill)}
                          onChange={(e) => updateVar('--radius-pill', `${e.target.value}px`)}
                        />
                        <button
                          type="button"
                          className={`pill-btn${radPill >= 900 ? ' active' : ''}`}
                          onClick={() => updateVar('--radius-pill', '999px')}
                        >
                          Full Pill
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </>
            )}

            {editorTab === 'spacing' && (
              <div className="theme-editor-group-card">
                <h4>Grid Gaps &amp; Component Padding</h4>
                <div className="theme-sliders-grid">
                  <div className="theme-slider-row">
                    <div className="theme-slider-head">
                      <span>Card Grid Gap</span>
                      <strong>{cardGap}px</strong>
                    </div>
                    <input
                      type="range"
                      min={4}
                      max={24}
                      step={1}
                      value={cardGap}
                      onChange={(e) => updateVar('--space-card-gap', `${e.target.value}px`)}
                    />
                  </div>
                  <div className="theme-slider-row">
                    <div className="theme-slider-head">
                      <span>Metric Row Gap</span>
                      <strong>{metricGap}px</strong>
                    </div>
                    <input
                      type="range"
                      min={2}
                      max={14}
                      step={1}
                      value={metricGap}
                      onChange={(e) => updateVar('--space-metric-gap', `${e.target.value}px`)}
                    />
                  </div>
                  <div className="theme-slider-row">
                    <div className="theme-slider-head">
                      <span>Metric Icon Size</span>
                      <strong>{iconSize}px</strong>
                    </div>
                    <input
                      type="range"
                      min={18}
                      max={38}
                      step={1}
                      value={iconSize}
                      onChange={(e) => updateVar('--metric-icon-size', `${e.target.value}px`)}
                    />
                  </div>
                  <div className="setting-field">
                    <label>Card Padding</label>
                    <input
                      type="text"
                      className="text-input"
                      value={draft.vars['--space-card-padding'] || '16px 18px'}
                      onChange={(e) => updateVar('--space-card-padding', e.target.value)}
                    />
                  </div>
                  <div className="setting-field">
                    <label>Metric Row Padding</label>
                    <input
                      type="text"
                      className="text-input"
                      value={draft.vars['--space-metric-padding'] || '8px 10px'}
                      onChange={(e) => updateVar('--space-metric-padding', e.target.value)}
                    />
                  </div>
                  <div className="setting-field">
                    <label>Button Padding</label>
                    <input
                      type="text"
                      className="text-input"
                      value={draft.vars['--space-btn-padding'] || '7px 13px'}
                      onChange={(e) => updateVar('--space-btn-padding', e.target.value)}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* Right Pane: Scoped Live Preview */}
        <aside className="theme-editor-preview-col">
          <div className="theme-preview-header">
            <div className="theme-preview-title">
              <Eye size={14} /> <span>Live Preview</span>
            </div>
            <div className="theme-library-swatches">
              {draft.swatches.map((hex, i) => (
                <span
                  key={i}
                  className="theme-swatch-dot"
                  style={{ backgroundColor: hex }}
                  title={hex}
                />
              ))}
            </div>
          </div>

          <div
            className="theme-preview-window"
            data-testid="theme-live-preview"
            data-theme-mode={draft.mode}
            data-theme-family={draft.family}
            style={previewCssVars}
          >
            {/* Preview Top Bar */}
            <div className="theme-preview-topbar">
              <div className="theme-preview-brand">
                <Sparkles size={12} style={{ color: 'var(--accent-sky)' }} />
                <strong>winAtmo</strong>
              </div>
              <span className="theme-preview-station-pill">
                <span className="theme-preview-dot" /> Home Station
              </span>
              <div className="theme-preview-win-dots">
                <span />
                <span />
                <span />
              </div>
            </div>

            {/* Preview App Header */}
            <div className="theme-preview-app-header">
              <div className="theme-preview-nav">
                <span className="theme-preview-nav-btn active">
                  <LayoutGrid size={11} /> Sensors
                </span>
                <span className="theme-preview-nav-btn">
                  <LineChart size={11} /> Charts
                </span>
              </div>
              <span className="theme-preview-sync-btn">
                <Check size={11} /> Synced
              </span>
            </div>

            {/* Preview Content Body */}
            <div className="theme-preview-body">
              <div className="theme-preview-section-title">
                <span>Living Room &amp; Outdoor</span>
                <small>{draft.mode.toUpperCase()} • {draft.styleLabel}</small>
              </div>

              {/* Sample Sensor Module Card */}
              <div className="theme-preview-card">
                <div className="theme-preview-card-head">
                  <div>
                    <div className="theme-preview-card-title-row">
                      <h5>Living Room</h5>
                      <span className="theme-preview-co2-badge">Excellent</span>
                    </div>
                    <span className="theme-preview-sub">Indoor Base Station</span>
                  </div>
                  <span className="theme-preview-hw-pill">89%</span>
                </div>

                <div className="theme-preview-metrics">
                  <div className="theme-preview-metric-row">
                    <div className="theme-preview-metric-left">
                      <span
                        className="theme-preview-icon-box"
                        style={{
                          color: 'var(--accent-sky)',
                          background: 'rgba(56, 189, 248, 0.14)',
                        }}
                      >
                        <Thermometer size={13} />
                      </span>
                      <div>
                        <div className="theme-preview-metric-name">Temperature</div>
                        <div className="theme-preview-metric-sub">Min 19.8° • Max 22.4°</div>
                      </div>
                    </div>
                    <div className="theme-preview-metric-right">
                      <span className="theme-preview-val">21.6°C</span>
                      <span className="theme-preview-action-icon">
                        <Pin size={10} />
                      </span>
                    </div>
                  </div>

                  <div className="theme-preview-metric-row">
                    <div className="theme-preview-metric-left">
                      <span
                        className="theme-preview-icon-box"
                        style={{
                          color: 'var(--accent-blue)',
                          background: 'rgba(37, 99, 235, 0.14)',
                        }}
                      >
                        <Droplets size={13} />
                      </span>
                      <div>
                        <div className="theme-preview-metric-name">Humidity</div>
                        <div className="theme-preview-metric-sub">Comfort range</div>
                      </div>
                    </div>
                    <div className="theme-preview-metric-right">
                      <span className="theme-preview-val">48%</span>
                      <span className="theme-preview-action-icon">
                        <LineChart size={10} />
                      </span>
                    </div>
                  </div>

                  <div className="theme-preview-metric-row co2">
                    <div className="theme-preview-metric-left">
                      <span
                        className="theme-preview-icon-box"
                        style={{
                          color: 'var(--accent-emerald)',
                          background: 'rgba(16, 185, 129, 0.14)',
                        }}
                      >
                        <Activity size={13} />
                      </span>
                      <div>
                        <div className="theme-preview-metric-name">CO₂ Level</div>
                        <div className="theme-preview-metric-sub">Fresh indoor air</div>
                      </div>
                    </div>
                    <div className="theme-preview-metric-right">
                      <span
                        className="theme-preview-val"
                        style={{ color: 'var(--accent-emerald)' }}
                      >
                        612 ppm
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Sample Mini Chart Card */}
              <div className="theme-preview-chart-card">
                <div className="theme-preview-chart-head">
                  <span>24h Temperature Curve</span>
                  <span style={{ color: 'var(--accent-sky)' }}>30min</span>
                </div>
                <svg viewBox="0 0 240 62" className="theme-preview-svg">
                  <line x1="0" y1="15" x2="240" y2="15" stroke="var(--chart-grid)" strokeWidth="1" />
                  <line x1="0" y1="35" x2="240" y2="35" stroke="var(--chart-grid)" strokeWidth="1" />
                  <line x1="0" y1="52" x2="240" y2="52" stroke="var(--chart-grid)" strokeWidth="1" />
                  <path
                    d="M 4 46 C 35 42, 65 24, 95 29 C 125 34, 155 12, 195 18 C 215 21, 228 16, 236 14"
                    fill="none"
                    stroke="var(--accent-sky)"
                    strokeWidth="2.2"
                  />
                  <path
                    d="M 4 50 C 40 48, 80 41, 120 43 C 160 45, 200 32, 236 30"
                    fill="none"
                    stroke="var(--accent-emerald)"
                    strokeWidth="1.6"
                    strokeDasharray="3 2"
                  />
                </svg>
              </div>

              {/* Sample Floating Widget Bar */}
              <div
                className="theme-preview-widget"
                style={{
                  background: `rgba(${draft.widgetBgRgb || '13, 19, 33'}, 0.92)`,
                }}
              >
                <span className="theme-preview-widget-pill">
                  <small>OUT</small> <strong>11.4°</strong>
                </span>
                <span className="theme-preview-widget-pill">
                  <small>IN</small> <strong>21.6°</strong>
                </span>
                <span className="theme-preview-widget-pill">
                  <small>CO₂</small>{' '}
                  <strong style={{ color: 'var(--accent-emerald)' }}>612</strong>
                </span>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
};
