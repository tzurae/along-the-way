import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useI18n } from "./i18n";

interface AccountSettingsDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  email: string;
  isAdmin: boolean;
  openAdmin(): void;
  signOut(): void;
  signOutEverywhere(): void;
  signingOutEverywhere: boolean;
}

export function AccountSettingsDialog({
  open,
  onOpenChange,
  email,
  isAdmin,
  openAdmin,
  signOut,
  signOutEverywhere,
  signingOutEverywhere,
}: AccountSettingsDialogProps) {
  const { t } = useI18n();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent placement="sheet" className="account-settings-dialog">
        <DialogHeader className="account-settings-dialog__header">
          <DialogTitle>{t.accountSettings.title}</DialogTitle>
        </DialogHeader>

        <div className="account-settings-dialog__body">
          <section className="account-settings-section" aria-labelledby="account-settings-account">
            <h3 id="account-settings-account" className="sr-only">{t.accountSettings.account}</h3>
            <dl className="account-settings-facts">
              <div>
                <dt>{t.accountSettings.email}</dt>
                <dd>{email}</dd>
              </div>
            </dl>
          </section>
          {isAdmin ? (
            <section className="account-settings-section" aria-labelledby="account-settings-services">
              <h3 id="account-settings-services" className="sr-only">{t.accountSettings.services}</h3>
              <div className="account-settings-menu">
                <button type="button" onClick={openAdmin}>
                  <ShieldCheck aria-hidden="true" />
                  <span>{t.admin.entry}</span>
                </button>
              </div>
            </section>
          ) : null}
        </div>

        <section className="account-settings-actions" aria-labelledby="account-settings-actions">
          <h3 id="account-settings-actions" className="sr-only">{t.accountSettings.signInActions}</h3>
          <Button type="button" variant="outline" className="account-settings-actions__button" onClick={signOut}>
            {t.app.signOut}
          </Button>
          <Button
            type="button"
            variant="destructive"
            className="account-settings-actions__button account-settings-actions__button--destructive"
            disabled={signingOutEverywhere}
            onClick={signOutEverywhere}
          >
            {signingOutEverywhere ? t.app.signingOutEverywhere : t.app.signOutEverywhere}
          </Button>
        </section>
      </DialogContent>
    </Dialog>
  );
}
