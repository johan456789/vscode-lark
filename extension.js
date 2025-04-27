const vscode = require('vscode');

function activate(context) {
    const selector = { language: 'lark', scheme: 'file' };
    const provider = new LarkSymbolProvider();
    context.subscriptions.push(vscode.languages.registerDocumentSymbolProvider(selector, provider));
    // Diagnostics for unused grammar symbols
    const diagnosticCollection = vscode.languages.createDiagnosticCollection('lark-unused');
    context.subscriptions.push(diagnosticCollection);
    // Validate currently open Lark document
    if (vscode.window.activeTextEditor) {
        const doc = vscode.window.activeTextEditor.document;
        if (doc.languageId === 'lark') validateTextDocument(doc, diagnosticCollection);
    }
    // Re-validate on change, open, close
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(e => validateTextDocument(e.document, diagnosticCollection))
    );
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(doc => validateTextDocument(doc, diagnosticCollection))
    );
    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument(doc => diagnosticCollection.delete(doc.uri))
    );
}

class LarkSymbolProvider {
    provideDocumentSymbols(document) {
        const symbols = [];
        const termRe = /^\s*(?:[?!])?([A-Z0-9_]+)(?:\.\d+)?\s*:/; // optional ?/! prefix, uppercase identifiers, optional .n suffix
        const ruleRe = /^\s*(?:[?!])?([a-z0-9_]+)(?:\.\d+)?\s*:/; // optional ?/! prefix, lowercase identifiers, optional .n suffix

        for (let i = 0; i < document.lineCount; i++) {
            const text = document.lineAt(i).text; // text content of the current line

            const termMatch = termRe.exec(text);
            if (termMatch) {
                const name = termMatch[1]; // terminal name
                const kind = vscode.SymbolKind.Constant;
                const range = new vscode.Range(i, 0, i, text.length);
                symbols.push(new vscode.DocumentSymbol(name, '', kind, range, range));
                continue;
            }

            const ruleMatch = ruleRe.exec(text);
            if (ruleMatch) {
                const name = ruleMatch[1]; // rule name
                const kind = vscode.SymbolKind.Function;
                const range = new vscode.Range(i, 0, i, text.length);
                symbols.push(new vscode.DocumentSymbol(name, '', kind, range, range));
            }
        }
        return symbols;
    }
}

// Check for unused grammar symbols and report warnings
function validateTextDocument(document, diagnosticCollection) {
    if (document.languageId !== 'lark') return;
    const diagnostics = [];
    const termRe = /^\s*(?:[?!])?([A-Z0-9_]+)(?:\.\d+)?\s*:/;
    const ruleRe = /^\s*(?:[?!])?([a-z0-9_]+)(?:\.\d+)?\s*:/;
    const defs = {};
    // Collect definitions
    for (let i = 0; i < document.lineCount; i++) {
        const text = document.lineAt(i).text;
        let match = termRe.exec(text);
        if (match) {
            defs[match[1]] = { line: i, used: false };
            continue;
        }
        match = ruleRe.exec(text);
        if (match) {
            defs[match[1]] = { line: i, used: false };
        }
    }
    // Search for references
    for (let i = 0; i < document.lineCount; i++) {
        const text = document.lineAt(i).text;
        for (const name in defs) {
            if (defs[name].used || i === defs[name].line) continue;
            if (new RegExp(`\\b${name}\\b`).test(text)) {
                defs[name].used = true;
            }
        }
    }
    // Create diagnostics for unused
    for (const name in defs) {
        if (!defs[name].used && name !== 'start') {
            const lineNum = defs[name].line;
            const line = document.lineAt(lineNum);
            const startChar = line.text.indexOf(name);
            if (startChar >= 0) {
                const range = new vscode.Range(lineNum, startChar, lineNum, startChar + name.length);
                diagnostics.push(new vscode.Diagnostic(range, `Unused grammar symbol '${name}'`, vscode.DiagnosticSeverity.Warning));
            }
        }
    }
    diagnosticCollection.set(document.uri, diagnostics);
}

function deactivate() { }

module.exports = { activate, deactivate };
