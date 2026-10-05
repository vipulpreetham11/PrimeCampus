import { useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router';
import { ArrowLeftRight, LayoutDashboard, LogOut, KeyRound, Menu, School, UserRound, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { roleLabel } from '@/contracts/roles';
import { logout } from '@/lib/session/session';
import { sessionStore, useSession, type SessionState } from '@/lib/session/store';
import { cn } from '@/lib/utils';
import { buildNav, type NavItem } from '../navigation';

function childName(s: SessionState): string | null {
  const id = s.context?.student_id;
  if (!id) return null;
  for (const c of s.contexts) {
    const child = c.children?.find((ch) => ch.student_id === id);
    if (child) return child.name;
  }
  return null;
}

/** Always-visible current school / year / role / child (CLAUDE.md UI baseline). */
function ContextSummary({ s }: { s: SessionState }) {
  const ctx = s.context;
  if (!ctx) {
    return (
      <p className="text-muted-foreground text-sm" data-testid="context-summary">
        No school selected
      </p>
    );
  }
  const child = childName(s);
  return (
    <dl className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm" data-testid="context-summary">
      <div className="flex items-center gap-1">
        <dt className="sr-only">School</dt>
        <School aria-hidden="true" className="text-muted-foreground size-4" />
        <dd className="font-medium">{ctx.school_name}</dd>
      </div>
      <div className="flex items-center gap-1">
        <dt className="text-muted-foreground">Year:</dt>
        <dd>{ctx.current_year?.name ?? 'Not set'}</dd>
      </div>
      <div className="flex items-center gap-1">
        <dt className="sr-only">Role</dt>
        <dd>
          <Badge variant="secondary">
            {roleLabel(ctx.role)}
            {ctx.via_operator ? ' (support)' : ''}
          </Badge>
        </dd>
      </div>
      {child && (
        <div className="flex items-center gap-1">
          <dt className="text-muted-foreground">Child:</dt>
          <dd className="font-medium">{child}</dd>
        </div>
      )}
    </dl>
  );
}

function NavList({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  const live = items.filter((i) => i.kind === 'live');
  const upcoming = items.filter((i) => i.kind === 'upcoming');
  return (
    <nav aria-label="Main" className="flex flex-col gap-4">
      <ul className="flex flex-col gap-1">
        {live.map((item) => (
          <li key={item.to}>
            <NavLink
              to={item.to}
              onClick={onNavigate}
              className={({ isActive }) =>
                cn(
                  'hover:bg-accent flex items-center gap-2 rounded-md px-3 py-2 text-sm',
                  isActive && 'bg-accent font-medium',
                )
              }
            >
              {({ isActive }) => (
                <>
                  {item.to === '/dashboard' ? (
                    <LayoutDashboard className="size-4" />
                  ) : (
                    <School className="size-4" />
                  )}
                  {item.label}
                  {isActive && <span className="sr-only">(current page)</span>}
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
      {upcoming.length > 0 && (
        <div>
          <p className="text-muted-foreground px-3 text-xs font-medium tracking-wide uppercase">
            Coming soon
          </p>
          <ul className="mt-1 flex flex-col gap-1" aria-label="Coming in later modules">
            {upcoming.map((item) => (
              <li
                key={item.label}
                className="text-muted-foreground flex items-center justify-between px-3 py-1.5 text-sm"
              >
                <span>{item.label}</span>
                <span className="text-xs">in {item.module}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </nav>
  );
}

export function AppShell() {
  const s = useSession();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const items = buildNav(s.context, s.account?.isOperator ?? false);
  const liveItems = items.filter((i): i is Extract<NavItem, { kind: 'live' }> => i.kind === 'live');

  const signOut = async () => {
    setSigningOut(true);
    await logout();
    navigate('/sign-in', { replace: true });
  };

  return (
    <div className="bg-muted/30 flex min-h-dvh flex-col">
      <header className="bg-background sticky top-0 z-30 border-b">
        <div className="mx-auto flex max-w-7xl items-center gap-2 px-4 py-2">
          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open menu">
                <Menu />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 p-4">
              <SheetHeader className="p-0">
                <SheetTitle>PrimeCampus</SheetTitle>
              </SheetHeader>
              <NavList items={items} onNavigate={() => setMenuOpen(false)} />
            </SheetContent>
          </Sheet>
          <Link to="/dashboard" className="font-semibold tracking-tight">
            PrimeCampus
          </Link>
          <div className="ml-auto flex items-center gap-1">
            <Button asChild variant="outline" size="sm">
              <Link to="/choose" data-testid="switch-context">
                <ArrowLeftRight />
                <span>Switch</span>
                <span className="sr-only"> role, school or child</span>
              </Link>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Account menu" data-testid="user-menu">
                  <UserRound />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="font-normal">
                  <p className="font-medium">{s.account?.displayName ?? s.account?.username}</p>
                  <p className="text-muted-foreground text-xs">{s.account?.username}</p>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => navigate('/change-password')}>
                  <KeyRound /> Change password
                </DropdownMenuItem>
                <DropdownMenuItem disabled={signingOut} onSelect={() => void signOut()}>
                  <LogOut /> Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <div className="mx-auto max-w-7xl px-4 pb-2">
          <ContextSummary s={s} />
        </div>
      </header>

      {s.notice?.kind === 'context_changed' && (
        <div
          role="status"
          className="border-b border-amber-300 bg-amber-50 text-amber-950"
          data-testid="context-notice"
        >
          <div className="mx-auto flex max-w-7xl items-start gap-2 px-4 py-2 text-sm">
            <p className="flex-1">
              <strong>Notice: </strong>
              {s.notice.message}
            </p>
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label="Dismiss notice"
              onClick={() => sessionStore.set({ notice: null })}
            >
              <X />
            </Button>
          </div>
        </div>
      )}

      <div className="mx-auto flex w-full max-w-7xl flex-1 gap-6 px-4 py-6 pb-24 md:pb-6">
        <aside className="hidden w-56 shrink-0 md:block">
          <NavList items={items} />
        </aside>
        <main className="min-w-0 flex-1" id="main">
          <Outlet />
        </main>
      </div>

      {/* Bottom navigation for phones: live destinations only. */}
      {liveItems.length > 0 && (
        <nav aria-label="Quick" className="bg-background fixed inset-x-0 bottom-0 z-30 border-t md:hidden">
          <ul className="flex">
            {liveItems.map((item) => (
              <li key={item.to} className="flex-1">
                <NavLink
                  to={item.to}
                  className={({ isActive }) =>
                    cn(
                      'flex flex-col items-center gap-0.5 py-2 text-xs',
                      isActive ? 'text-foreground font-semibold' : 'text-muted-foreground',
                    )
                  }
                >
                  {item.to === '/dashboard' ? (
                    <LayoutDashboard className="size-5" />
                  ) : (
                    <School className="size-5" />
                  )}
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </div>
  );
}
