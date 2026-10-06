import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface OneTimeSecretDialogProps {
  /** The temporary password. The parent must drop it from state in `onClose`. */
  secret: string | null;
  username: string;
  title?: string;
  onClose: () => void;
}

/**
 * Shows a temporary password exactly once (CLAUDE.md rule 10): never stored, logged, cached or
 * put in a URL. Closing the dialog clears it; there is no way to show it again.
 */
export function OneTimeSecretDialog({
  secret,
  username,
  title = 'Temporary password',
  onClose,
}: OneTimeSecretDialogProps) {
  const [copied, setCopied] = useState(false);
  const open = secret !== null;

  const close = () => {
    setCopied(false);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Give this to <strong>{username}</strong> in person or by phone. It will not be shown again. They
            must change it when they first sign in.
          </DialogDescription>
        </DialogHeader>
        {secret !== null && (
          <div className="flex items-center gap-2">
            <code
              data-testid="one-time-secret"
              className="bg-muted flex-1 rounded-md border px-3 py-2 font-mono text-lg tracking-wide select-all"
            >
              {secret}
            </code>
            <Button
              variant="outline"
              size="icon"
              aria-label={copied ? 'Copied' : 'Copy password'}
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(secret)
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false));
              }}
            >
              {copied ? <Check /> : <Copy />}
            </Button>
          </div>
        )}
        <p className="text-muted-foreground text-sm" aria-live="polite">
          {copied ? 'Copied to clipboard.' : ''}
        </p>
        <DialogFooter>
          <Button onClick={close}>I have noted it — close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
