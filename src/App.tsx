import { useState, useCallback, useEffect } from 'react';
import { useBackup, type BackupInfo } from './hooks/useBackup';
import HomeScreen from './components/HomeScreen';
import ExploreLayout from './components/explore/ExploreLayout';
import BackupFlow from './components/backup/BackupFlow';
import PasswordDialog from './components/shared/PasswordDialog';
import type { RecentSession } from './lib/appState';

type Screen = 'home' | 'explore' | 'create-backup';

interface PendingOpen {
  udid: string;
  backupDir?: string;
  deviceName?: string;
  session?: RecentSession;
  backupInfo?: BackupInfo;
}

function sessionFromInfo(info: BackupInfo, existing?: RecentSession): RecentSession {
  return existing ?? {
    id: info.udid,
    type: 'device',
    name: info.device_name,
    subtitle: `iOS ${info.product_version}`,
    exportCount: 0,
    lastOpened: new Date().toISOString(),
    iosVersion: info.product_version,
    backupDir: info.backup_dir,
  };
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('home');
  const backup = useBackup();
  const [currentSession, setCurrentSession] = useState<RecentSession | null>(null);
  const [pendingOpen, setPendingOpen] = useState<PendingOpen | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  // Listen for backup.opened notification from command-line --backup
  // Also check for already-opened backup on mount (in case notification was sent before React loaded)
  useEffect(() => {
    const checkForAutoOpenedBackup = async () => {
      try {
        const sessions = await window.openextract.getRecentSessions();
        // Find the most recently opened backup
        if (sessions && sessions.length > 0) {
          const latest = sessions[0];
          // Check if it was opened very recently (within last 5 seconds)
          const lastOpened = new Date(latest.lastOpened);
          const now = new Date();
          const diffMs = now.getTime() - lastOpened.getTime();
          if (diffMs < 5000 && latest.type === 'device' && latest.backupDir) {
            // This was likely opened via --backup, open it in the backup hook and navigate
            const result = await backup.openBackup(latest.id, undefined, latest.backupDir);
            if (result.status === 'open' && result.info) {
              setCurrentSession(latest);
              setScreen('explore');
            }
          }
        }
      } catch (e) {
        console.error('Failed to check for auto-opened backup:', e);
      }
    };

    checkForAutoOpenedBackup();

    const unsubscribe = window.openextract.onNotification((notification) => {
      if (notification.method === 'backup.opened') {
        const params = notification.params;
        const session: RecentSession = {
          id: params.udid,
          type: 'device',
          name: params.device_name,
          subtitle: `iOS ${params.product_version}`,
          exportCount: 0,
          lastOpened: new Date().toISOString(),
          iosVersion: params.product_version,
          backupDir: params.backup_dir,
        };
        // Open the backup in the hook and navigate
        backup.openBackup(session.id, undefined, session.backupDir).then((result) => {
          if (result.status === 'open' && result.info) {
            setCurrentSession(session);
            setScreen('explore');
          }
        });
      }
    });
    return unsubscribe;
  }, [backup]);

  const openAndNavigate = useCallback(async (
    udid: string,
    password: string | undefined,
    backupDir: string | undefined,
    session: RecentSession | undefined,
    backupInfo: BackupInfo | undefined,
  ) => {
    setOpenError(null);
    const result = await backup.openBackup(udid, password, backupDir);

    if (result.status === 'password_required') {
      setPendingOpen({ udid, backupDir, deviceName: session?.name ?? backupInfo?.device_name, session, backupInfo });
      return;
    }

    if (result.status === 'open' && result.info) {
      setCurrentSession(sessionFromInfo(result.info, session));
      setScreen('explore');
      setPendingOpen(null);
      setPasswordError(null);
      return;
    }

    if (result.status.startsWith('error:')) {
      setOpenError(result.status.slice(6));
    } else {
      setOpenError(`Could not open backup (status: ${result.status}).`);
    }
  }, [backup]);

  const handlePasswordSubmit = useCallback(async (password: string) => {
    if (!pendingOpen) return;
    setUnlocking(true);
    setPasswordError(null);
    try {
      const result = await backup.openBackup(pendingOpen.udid, password, pendingOpen.backupDir);
      if (result.status === 'password_required') {
        setPasswordError('Incorrect password. Please try again.');
      } else if (result.status === 'open' && result.info) {
        setCurrentSession(sessionFromInfo(result.info, pendingOpen.session));
        setScreen('explore');
        setPendingOpen(null);
        setPasswordError(null);
      } else if (result.status.startsWith('error:')) {
        setPasswordError(result.status.slice(6));
      }
    } finally {
      setUnlocking(false);
    }
  }, [pendingOpen, backup]);

  return (
    <div className="h-screen flex flex-col bg-base text-text-primary">
      {screen === 'home' && (
        <HomeScreen
          onOpenBackup={async (session) => {
            await openAndNavigate(session.id, undefined, session.backupDir, session, undefined);
          }}
          onCreateBackup={() => setScreen('create-backup')}
          onBrowseForBackup={async () => {
            setOpenError(null);
            const path = await window.openextract.selectFolder();
            if (!path) return;
            try {
              const found = await backup.listBackups(path, true);
              if (found.length === 0) {
                setOpenError(`No iPhone backups found in ${path}. Pick the parent folder that contains a UDID-named subfolder (e.g. MobileSync/Backup).`);
                return;
              }
              const b = found[0];
              await openAndNavigate(b.udid, undefined, b.backup_dir, undefined, b);
            } catch (e: any) {
              setOpenError(e?.message || 'Failed to read backup folder.');
            }
          }}
        />
      )}

      {screen === 'explore' && backup.activeBackup && (
        <ExploreLayout
          udid={backup.activeBackup.udid}
          session={currentSession}
          onBack={() => {
            backup.setActiveBackup(null);
            setCurrentSession(null);
            setScreen('home');
          }}
        />
      )}

      {screen === 'create-backup' && (
        <BackupFlow
          onBack={() => setScreen('home')}
          onBackupComplete={async (udid, backupPath) => {
            await openAndNavigate(udid, undefined, backupPath, undefined, undefined);
            return 'open';
          }}
        />
      )}

      {openError && screen === 'home' && (
        <div
          role="alert"
          className="fixed left-1/2 -translate-x-1/2 bottom-6 z-40 max-w-md w-[90%] px-4 py-3 rounded-xl flex items-start gap-3 text-sm"
          style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-strong)',
            color: 'var(--text-primary)',
            boxShadow: '0 10px 28px rgba(30,26,22,0.18)',
          }}
        >
          <span
            className="flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-white text-xs mt-0.5"
            style={{ background: 'var(--error)' }}
          >!</span>
          <div className="flex-1 min-w-0">
            <div className="font-medium mb-0.5">Couldn't open backup</div>
            <div className="text-xs text-text-secondary break-words">{openError}</div>
          </div>
          <button
            onClick={() => setOpenError(null)}
            className="text-text-tertiary hover:text-text-primary flex-shrink-0"
            aria-label="Dismiss"
          >×</button>
        </div>
      )}

      {pendingOpen && (
        <PasswordDialog
          deviceName={pendingOpen.deviceName}
          error={passwordError}
          loading={unlocking}
          onSubmit={handlePasswordSubmit}
          onCancel={() => {
            setPendingOpen(null);
            setPasswordError(null);
          }}
        />
      )}
    </div>
  );
}
