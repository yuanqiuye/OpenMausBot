import { useRef, useState, type ChangeEvent } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { api } from "@/state/store";
import type { ApnsStatusSummary } from "@/state/config-status";
import { sameFields, useStoreDispatch, useStoreSelector } from "@/state/store-select";
import { Select } from "./Select";
import {
  SETTINGS_INPUT,
  SettingRow,
  SettingsField,
  SettingsFoldRow,
  SettingsFormFoot,
  SettingsGroup,
  SettingsRows,
  StatusDot,
  Switch,
} from "./SettingsPrimitives";

interface SaveResponse {
  apns: ApnsStatusSummary;
}

interface TestResponse {
  ok: boolean;
  sent?: number;
  total?: number;
  error?: string;
}

export function IosPushSettingsSection() {
  const state = useStoreSelector((s) => ({ config: s.config }), sameFields);
  const dispatch = useStoreDispatch();
  const apns = state.config?.apns;

  const [open, setOpen] = useState(false);
  const [enabledDraft, setEnabledDraft] = useState<boolean | null>(null);
  const [environmentDraft, setEnvironmentDraft] = useState<"sandbox" | "production" | null>(null);
  const [teamIdDraft, setTeamIdDraft] = useState<string | null>(null);
  const [keyIdDraft, setKeyIdDraft] = useState<string | null>(null);
  const [bundleIdDraft, setBundleIdDraft] = useState<string | null>(null);
  const [privateKeyDraft, setPrivateKeyDraft] = useState("");
  const [clearPrivateKey, setClearPrivateKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<{ ok: boolean; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const enabled = enabledDraft ?? (apns?.enabled ?? true);
  const environment = environmentDraft ?? (apns?.environment ?? "sandbox");
  const teamId = teamIdDraft ?? (apns?.teamId ?? "");
  const keyId = keyIdDraft ?? (apns?.keyId ?? "");
  const bundleId = bundleIdDraft ?? (apns?.bundleId ?? "");
  const hasSavedKey = Boolean(apns?.hasPrivateKey) && !clearPrivateKey;
  const configured = Boolean(apns?.configured);
  const apnsDevices = apns?.apnsDevices ?? 0;

  const dirty = enabledDraft !== null
    || environmentDraft !== null
    || (teamIdDraft !== null && teamIdDraft.trim().toUpperCase() !== (apns?.teamId ?? ""))
    || (keyIdDraft !== null && keyIdDraft.trim().toUpperCase() !== (apns?.keyId ?? ""))
    || (bundleIdDraft !== null && bundleIdDraft.trim() !== (apns?.bundleId ?? ""))
    || Boolean(privateKeyDraft.trim())
    || clearPrivateKey;

  const applyApns = (next: ApnsStatusSummary) => {
    if (state.config) dispatch({ type: "configStatus", config: { ...state.config, apns: next } });
  };

  const resetFeedback = () => {
    setError(null);
    setVerdict(null);
  };

  const handleFilePick = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    resetFeedback();
    const content = await file.text();
    setClearPrivateKey(false);
    setPrivateKeyDraft(content.trim());
    const match = /^AuthKey_([A-Za-z0-9]{10})\.p8$/i.exec(file.name.trim());
    if (match && !keyId.trim()) setKeyIdDraft(match[1]!.toUpperCase());
  };

  const save = async () => {
    if (saving || !dirty) return;
    setSaving(true);
    resetFeedback();
    try {
      const response = await api<SaveResponse>("/api/push/apns", {
        method: "PUT",
        body: JSON.stringify({
          enabled,
          environment,
          teamId: teamId.trim().toUpperCase(),
          keyId: keyId.trim().toUpperCase(),
          bundleId: bundleId.trim(),
          ...(privateKeyDraft.trim() ? { privateKey: privateKeyDraft.trim() } : {}),
          ...(clearPrivateKey && !privateKeyDraft.trim() ? { clearPrivateKey: true } : {}),
        }),
      });
      applyApns(response.apns);
      setEnabledDraft(null);
      setEnvironmentDraft(null);
      setTeamIdDraft(null);
      setKeyIdDraft(null);
      setBundleIdDraft(null);
      setPrivateKeyDraft("");
      setClearPrivateKey(false);
      setVerdict({ ok: true, text: t("phone.apns.saved") });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    if (testing || saving || !configured) return;
    setTesting(true);
    resetFeedback();
    try {
      const result = await api<TestResponse>("/api/push/apns/test", { method: "POST", body: "{}" });
      setVerdict({
        ok: true,
        text: t("phone.apns.testSent", { sent: String(result.sent ?? 1), total: String(result.total ?? 1) }),
      });
    } catch (cause) {
      setVerdict({ ok: false, text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setTesting(false);
    }
  };

  const statusText = !enabled
    ? t("phone.apns.statusOff")
    : configured
      ? t("phone.apns.statusReady")
      : t("phone.apns.statusNotSetUp");

  return (
    <SettingsGroup label={t("phone.apns.title")} description={t("phone.apns.description")} block="ios-apns">
      <SettingsRows selectWidth={200}>
        <SettingsFoldRow
          id="ios-apns"
          title={t("phone.apns.foldTitle")}
          subtitle={t("phone.apns.foldSubtitle")}
          value={<span className="flex items-center"><StatusDot tone={enabled && configured ? "success" : null} />{statusText}</span>}
          open={open}
          onToggle={() => setOpen((prev) => !prev)}
        >
          <SettingRow title={t("phone.apns.enabled")} subtitle={t("phone.apns.enabledDetail")}>
            <Switch
              checked={enabled}
              disabled={saving}
              aria-label={t("phone.apns.enabled")}
              onClick={() => { resetFeedback(); setEnabledDraft(!enabled); }}
            />
          </SettingRow>
          <SettingRow title={t("phone.apns.environment")} subtitle={t("phone.apns.environmentDetail")}>
            <Select
              aria-label={t("phone.apns.environment")}
              value={environment}
              disabled={saving}
              onChange={(event) => {
                resetFeedback();
                setEnvironmentDraft(event.target.value === "production" ? "production" : "sandbox");
              }}
            >
              <option value="sandbox">{t("phone.apns.environmentSandbox")}</option>
              <option value="production">{t("phone.apns.environmentProduction")}</option>
            </Select>
          </SettingRow>
          <div className="flex flex-col gap-3 px-4 py-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <SettingsField label={t("phone.apns.teamId")}>
                <input
                  type="text"
                  data-testid="apns-team-id"
                  value={teamId}
                  maxLength={10}
                  disabled={saving}
                  placeholder="AB12CD34EF"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => { resetFeedback(); setTeamIdDraft(event.target.value.toUpperCase()); }}
                  className={cn(SETTINGS_INPUT, "font-mono uppercase")}
                />
              </SettingsField>
              <SettingsField label={t("phone.apns.keyId")}>
                <input
                  type="text"
                  data-testid="apns-key-id"
                  value={keyId}
                  maxLength={10}
                  disabled={saving}
                  placeholder="9988776655"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => { resetFeedback(); setKeyIdDraft(event.target.value.toUpperCase()); }}
                  className={cn(SETTINGS_INPUT, "font-mono uppercase")}
                />
              </SettingsField>
            </div>
            <SettingsField label={t("phone.apns.bundleId")} hint={t("phone.apns.bundleIdHint")}>
              <input
                type="text"
                data-testid="apns-bundle-id"
                value={bundleId}
                maxLength={155}
                disabled={saving}
                placeholder="com.example.mausbot"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => { resetFeedback(); setBundleIdDraft(event.target.value); }}
                className={cn(SETTINGS_INPUT, "font-mono")}
              />
            </SettingsField>
            <SettingsField label={t("phone.apns.privateKey")} hint={t("phone.apns.privateKeyHint")}>
              <textarea
                data-testid="apns-private-key"
                value={privateKeyDraft}
                disabled={saving}
                placeholder={hasSavedKey ? t("phone.apns.privateKeySavedPlaceholder") : t("phone.apns.privateKeyPlaceholder")}
                spellCheck={false}
                onChange={(event) => {
                  resetFeedback();
                  setClearPrivateKey(false);
                  setPrivateKeyDraft(event.target.value);
                }}
                className={cn(SETTINGS_INPUT, "h-24 resize-y py-2 font-mono text-[12px]")}
              />
            </SettingsField>
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept=".p8,.pem,text/plain"
                onChange={(event) => void handleFilePick(event)}
                className="hidden"
              />
              <button
                type="button"
                disabled={saving}
                onClick={() => fileInputRef.current?.click()}
                className="ui-button ui-button-sm cursor-pointer rounded-full"
              >
                {t("phone.apns.chooseFile")}
              </button>
              {hasSavedKey && (
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => {
                    resetFeedback();
                    setPrivateKeyDraft("");
                    setClearPrivateKey(true);
                  }}
                  className="ui-button ui-button-sm cursor-pointer rounded-full text-danger"
                >
                  {t("phone.apns.clearKey")}
                </button>
              )}
            </div>
          </div>
          <SettingsFormFoot
            status={<span className="flex flex-col gap-1">
              <span role="status" className="flex items-center">
                {enabled && configured ? <StatusDot tone="success" /> : <span aria-hidden="true" className="mr-1.5 inline-block size-1.5 rounded-full bg-ink/20" />}
                {statusText} · {t("phone.apns.devicesCount", { count: String(apnsDevices) })}
              </span>
              {error && <span role="alert" className="text-danger">{error}</span>}
              {verdict && <span role="status" className={verdict.ok ? "text-ink-secondary" : "text-danger"}>{verdict.text}</span>}
            </span>}
          >
            <button
              type="button"
              data-testid="apns-test"
              disabled={testing || saving || !configured || dirty}
              onClick={() => void sendTest()}
              className="ui-button ui-button-md cursor-pointer rounded-full"
            >
              {testing ? t("phone.apns.sendingTest") : t("phone.apns.sendTest")}
            </button>
            <button
              type="button"
              data-testid="apns-save"
              disabled={saving || !dirty}
              onClick={() => void save()}
              className="ui-button ui-button-md ui-button-primary cursor-pointer rounded-full"
            >
              {saving ? t("phone.apns.saving") : t("common.save")}
            </button>
          </SettingsFormFoot>
        </SettingsFoldRow>
      </SettingsRows>
    </SettingsGroup>
  );
}
