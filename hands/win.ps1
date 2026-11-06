# win.ps1 - look at and drive a Windows app by window, not by desktop.
#
#   list                          every visible top-level window: hwnd, pid, title
#   shot  <match> <out.png>       capture that window's own pixels
#   tree  <match>                 child controls (class, text, client rect)
#   click <match> <x> <y>         post a click at client coords (background)
#   type  <match> <text>          post text to the window's edit control (background)
#   key   <match> <vk>            post a virtual-key press (e.g. RETURN, TAB, ESCAPE)
#   focus <match>                 bring it forward - the fallback when posting is ignored
#
# <match> is a pid or a case-insensitive substring of the title.
#
# Capture uses PrintWindow(PW_RENDERFULLCONTENT), which asks the window to draw
# itself into a bitmap. It therefore works while the window is covered, on another
# monitor, or off-screen, and never steals focus or moves anything. A minimised
# window is restored with SW_SHOWNOACTIVATE (no activation) and re-minimised after.
#
# Input is PostMessage, which is best-effort by nature: Win32 controls accept it,
# and most Flutter/Electron/Chromium windows do too, but a window that reads raw
# input state (games, some custom renderers) will ignore it. Nothing posted is
# observed to have happened - screenshot after, and fall back to `focus` plus the
# computer-use MCP when the posted input does not land.
param([Parameter(Position=0)][string]$cmd='list',
      [Parameter(Position=1)][string]$target,
      [Parameter(Position=2)][string]$a1,
      [Parameter(Position=3)][string]$a2)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;using System.Runtime.InteropServices;using System.Text;using System.Collections.Generic;
public static class W{
 public delegate bool EP(IntPtr h,IntPtr l);
 [DllImport("user32")]public static extern bool EnumWindows(EP p,IntPtr l);
 [DllImport("user32")]public static extern bool EnumChildWindows(IntPtr h,EP p,IntPtr l);
 [DllImport("user32")]public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32")]public static extern bool IsIconic(IntPtr h);
 [DllImport("user32",CharSet=CharSet.Unicode)]public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 [DllImport("user32",CharSet=CharSet.Unicode)]public static extern int GetClassName(IntPtr h,StringBuilder s,int n);
 [DllImport("user32")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32")]public static extern bool GetWindowRect(IntPtr h,out R r);
 [DllImport("user32")]public static extern bool GetClientRect(IntPtr h,out R r);
 [DllImport("user32")]public static extern bool ShowWindow(IntPtr h,int c);
 [DllImport("user32")]public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32")]public static extern bool PrintWindow(IntPtr h,IntPtr dc,uint f);
 [DllImport("user32")]public static extern bool SetProcessDPIAware();
 [DllImport("user32")]public static extern IntPtr ChildWindowFromPointEx(IntPtr h,P pt,uint f);
 [DllImport("user32")]public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
 [StructLayout(LayoutKind.Sequential)]public struct R{public int L,T,Rt,B;}
 [StructLayout(LayoutKind.Sequential)]public struct P{public int X,Y;}
 static List<IntPtr> buf;
 public static List<IntPtr> Top(){buf=new List<IntPtr>();EnumWindows((h,x)=>{if(IsWindowVisible(h))buf.Add(h);return true;},IntPtr.Zero);return buf;}
 public static List<IntPtr> Kids(IntPtr p){var l=new List<IntPtr>();EnumChildWindows(p,(h,x)=>{l.Add(h);return true;},IntPtr.Zero);return l;}
 public static string Title(IntPtr h){var s=new StringBuilder(512);GetWindowText(h,s,512);return s.ToString();}
 public static string Cls(IntPtr h){var s=new StringBuilder(256);GetClassName(h,s,256);return s.ToString();}
 public static uint Pid(IntPtr h){uint p;GetWindowThreadProcessId(h,out p);return p;}
}
'@
[W]::SetProcessDPIAware() | Out-Null

function Get-Wins {
  [W]::Top() | ForEach-Object {
    [pscustomobject]@{ h=$_; title=[W]::Title($_); procid=[W]::Pid($_); min=[W]::IsIconic($_) }
  } | Where-Object { $_.title }
}

function Resolve-Win([string]$m) {
  if (!$m) { Write-Error 'need a window: a pid or part of its title'; exit 2 }
  $all = Get-Wins
  $w = $all | Where-Object { "$($_.procid)" -eq $m } | Select-Object -First 1
  if (!$w) { $w = $all | Where-Object { $_.title -like "*$m*" } | Select-Object -First 1 }
  if (!$w) { Write-Error "no window matching '$m' - run: win.ps1 list"; exit 2 }
  $w
}

# PostMessage ignores a window the user cannot see, so a minimised target is shown
# without activation first. Returns $true when it was minimised, so callers restore it.
function Unhide($w) { if ($w.min) { [W]::ShowWindow($w.h,4) | Out-Null; Start-Sleep -Milliseconds 300; $true } else { $false } }

switch ($cmd) {

 'list' {
   Get-Wins | ForEach-Object { "{0}`t{1}`t{2}{3}" -f $_.h.ToInt64(), $_.procid, $_.title, $(if($_.min){' [minimised]'}) }
 }

 'shot' {
   if (!$a1) { Write-Error 'need an output path: win.ps1 shot <match> <out.png>'; exit 2 }
   $w = Resolve-Win $target; $was = Unhide $w
   $r = New-Object W+R; [W]::GetWindowRect($w.h,[ref]$r) | Out-Null
   $bw = $r.Rt - $r.L; $bh = $r.B - $r.T
   if ($bw -le 0 -or $bh -le 0) { Write-Error 'window has no size'; exit 3 }
   $bmp = New-Object Drawing.Bitmap $bw,$bh
   $g = [Drawing.Graphics]::FromImage($bmp); $dc = $g.GetHdc()
   $ok = [W]::PrintWindow($w.h,$dc,2)   # PW_RENDERFULLCONTENT: DWM-composited content
   $g.ReleaseHdc($dc); $g.Dispose()
   $bmp.Save($a1,[Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
   if ($was) { [W]::ShowWindow($w.h,6) | Out-Null }
   if (!$ok) { Write-Warning 'PrintWindow returned false - image may be blank' }
   "{0}x{1} {2}" -f $bw,$bh,$w.title
 }

 'tree' {
   $w = Resolve-Win $target
   [W]::Kids($w.h) | ForEach-Object {
     $r = New-Object W+R; [W]::GetWindowRect($_,[ref]$r) | Out-Null
     "{0}`t{1}`t{2}`t{3},{4} {5}x{6}" -f $_.ToInt64(), [W]::Cls($_), [W]::Title($_), $r.L, $r.T, ($r.Rt-$r.L), ($r.B-$r.T)
   }
 }

 'click' {
   if (!$a1 -or !$a2) { Write-Error 'need client coords: win.ps1 click <match> <x> <y>'; exit 2 }
   $w = Resolve-Win $target; Unhide $w | Out-Null
   $x = [int]$a1; $y = [int]$a2
   $pt = New-Object W+P; $pt.X = $x; $pt.Y = $y
   # 3 = CWP_SKIPINVISIBLE|CWP_SKIPDISABLED. A child at the point takes the message
   # with coords relative to itself; with no child, the top window takes it as-is.
   $h = [W]::ChildWindowFromPointEx($w.h,$pt,3)
   if ($h -eq [IntPtr]::Zero) { $h = $w.h }
   if ($h -ne $w.h) {
     $pr = New-Object W+R; [W]::GetWindowRect($w.h,[ref]$pr) | Out-Null
     $cr = New-Object W+R; [W]::GetWindowRect($h,[ref]$cr) | Out-Null
     $x -= ($cr.L - $pr.L); $y -= ($cr.T - $pr.T)
   }
   $lp = [IntPtr](($y -shl 16) -bor ($x -band 0xFFFF))
   [W]::PostMessage($h,0x0201,[IntPtr]1,$lp) | Out-Null  # WM_LBUTTONDOWN, MK_LBUTTON
   Start-Sleep -Milliseconds 40
   [W]::PostMessage($h,0x0202,[IntPtr]0,$lp) | Out-Null  # WM_LBUTTONUP
   "clicked {0},{1} in {2}" -f $x, $y, [W]::Cls($h)
 }

 'type' {
   if ($null -eq $a1) { Write-Error 'need text: win.ps1 type <match> <text>'; exit 2 }
   $w = Resolve-Win $target; Unhide $w | Out-Null
   # An edit control is the only child that reliably accepts WM_CHAR; Chromium and
   # Flutter windows have none, and take it on the top window instead.
   $h = [W]::Kids($w.h) | Where-Object { [W]::Cls($_) -match 'Edit|RichEdit' } | Select-Object -First 1
   if (!$h) { $h = $w.h }
   foreach ($ch in $a1.ToCharArray()) { [W]::PostMessage($h,0x0102,[IntPtr][int]$ch,[IntPtr]0) | Out-Null }  # WM_CHAR
   "typed {0} chars into {1}" -f $a1.Length, [W]::Cls($h)
 }

 'key' {
   if (!$a1) { Write-Error 'need a key: win.ps1 key <match> <RETURN|TAB|ESCAPE|...>'; exit 2 }
   $w = Resolve-Win $target; Unhide $w | Out-Null
   $vk = [int][Windows.Forms.Keys]::$a1
   if (!$vk) { Write-Error "unknown key '$a1'"; exit 2 }
   $h = [W]::Kids($w.h) | Where-Object { [W]::Cls($_) -match 'Edit|RichEdit' } | Select-Object -First 1
   if (!$h) { $h = $w.h }
   [W]::PostMessage($h,0x0100,[IntPtr]$vk,[IntPtr]0) | Out-Null  # WM_KEYDOWN
   Start-Sleep -Milliseconds 30
   [W]::PostMessage($h,0x0101,[IntPtr]$vk,[IntPtr]0) | Out-Null  # WM_KEYUP
   "key $a1"
 }

 'focus' {
   $w = Resolve-Win $target
   [W]::ShowWindow($w.h,9) | Out-Null      # SW_RESTORE
   [W]::SetForegroundWindow($w.h) | Out-Null
   "focused {0}" -f $w.title
 }

 default { Write-Error "unknown command '$cmd' - list|shot|tree|click|type|key|focus"; exit 2 }
}
