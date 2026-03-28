
import * as vscode from 'vscode';

export class TroubleshootingGuide {
    public static showGuide() {
        const panel = vscode.window.createWebviewPanel(
            'troubleshootingGuide',
            'Troubleshooting Guide',
            vscode.ViewColumn.One,
            {}
        );

        panel.webview.html = `
<html>
<head>
    <title>Troubleshooting Guide</title>
</head>
<body>
    <h1>Troubleshooting Guide</h1>
    <h2>Common Issues</h2>
    <ul>
        <li><a href="#issue1">Issue 1: Slow Performance</a></li>
        <li><a href="#issue2">Crashing Extension</a></li>
        <li><a href="#issue3">Missing Feature</a></li>
    </ul>

    <h3 id="issue1">Issue 1: Slow Performance</h3>
    <p>Steps to resolve:</p>
    <ol>
        <li>Restart the extension.</li>
        <li>Disable unnecessary extensions.</li>
    </ol>

    <h3 id="issue2">Crashing Extension</h3>
    <p>Steps to resolve:</p>
    <ol>
        <li>Update the extension to the latest version.</li>
        <li>Check for compatibility issues with other extensions.</li>
    </ol>

    <h3 id="issue3">Missing Feature</h3>
    <p>Steps to resolve:</p>
    <ol>
        <li>Contact support for assistance.</li>
    </ol>
</body>
</html>
        `;
    }
}
```