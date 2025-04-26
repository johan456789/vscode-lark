const vscode = require('vscode');

function activate(context) {
    const selector = { language: 'lark', scheme: 'file' };
    const provider = new LarkSymbolProvider();
    context.subscriptions.push(
        vscode.languages.registerDocumentSymbolProvider(selector, provider)
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

function deactivate() { }

module.exports = { activate, deactivate };
