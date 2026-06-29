# Electron for Windows Desktop App

Bud is a Windows-only desktop companion. The original Clicky is a native macOS app built with SwiftUI, AppKit, ScreenCaptureKit, AVAudioEngine, and CGEvent taps — none of which exist on Windows. This is a ground-up rewrite, not a port.

We chose Electron (TypeScript) because it provides all required OS-level capabilities — system tray, transparent always-on-top windows (for the companion overlay), global keyboard hooks, screen capture via `desktopCapturer`, and audio recording via Web Audio API — within a single language (TypeScript) that the developer is learning and that matches the existing worker code. The ecosystem is battle-tested (Discord, VS Code, Slack) and every problem Bud will face has been solved before.

## Considered Options

- **WPF / WinUI 3 (.NET/C#)**: More native feel, but requires learning C# + XAML simultaneously. Steeper curve for a first app, and the community around transparent overlays and global hooks is smaller.
- **Tauri (Rust + web frontend)**: Lighter than Electron (~10MB vs ~150MB), but Rust is a significant learning curve, and transparent overlay support is less mature on Windows.
- **Python + PyQt**: Easy to prototype, but audio/overlay performance is mediocre and packaging is painful.
