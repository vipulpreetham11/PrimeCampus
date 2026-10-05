import { createRef } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Select, SelectTrigger, SelectValue } from '@/components/ui/select';

// Regression: the shadcn v4 registry assumes React 19 (ref as a prop). On React 18 the
// primitives must forwardRef, or Radix asChild triggers lose their anchor (menus never get
// positioned) and React Hook Form cannot focus invalid fields.
describe('shadcn primitives forward refs on React 18', () => {
  it('Button, Input and SelectTrigger expose their DOM node', () => {
    const b = createRef<HTMLButtonElement>();
    const i = createRef<HTMLInputElement>();
    const s = createRef<HTMLButtonElement>();
    render(
      <>
        <Button ref={b}>Go</Button>
        <Input ref={i} aria-label="name" />
        <Select>
          <SelectTrigger ref={s} aria-label="pick">
            <SelectValue placeholder="x" />
          </SelectTrigger>
        </Select>
      </>,
    );
    expect(b.current).toBeInstanceOf(HTMLButtonElement);
    expect(i.current).toBeInstanceOf(HTMLInputElement);
    expect(s.current).toBeInstanceOf(HTMLButtonElement);
  });

  it('Button works as an asChild menu trigger', async () => {
    render(
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button>Account</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Sign out</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Account' }));
    expect(await screen.findByRole('menuitem', { name: 'Sign out' })).toBeInTheDocument();
  });
});
