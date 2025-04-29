const vscode = require('vscode');

// regex patterns
const SYMBOL_PREFIX = '^\\s*(?:[?!])?';
const SYMBOL_SUFFIX = '(?:\\.\\d+)?';
const TERM_BODY = '([A-Z_][A-Z_0-9]*)';
const RULE_BODY = '([a-z_][a-z_0-9]*)';

function activate(context) {
    const selector = { language: 'lark', scheme: 'file' };
    const provider = new LarkSymbolProvider();
    context.subscriptions.push(vscode.languages.registerDocumentSymbolProvider(selector, provider));
    // Diagnostics for unused or undefined symbols
    const diagnosticCollection = vscode.languages.createDiagnosticCollection('lark-diagnostics');
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
        const termRe = new RegExp(`${SYMBOL_PREFIX}${TERM_BODY}${SYMBOL_SUFFIX}\\s*`); // optional ?/! prefix, uppercase identifiers, optional .n suffix
        const ruleRe = new RegExp(`${SYMBOL_PREFIX}${RULE_BODY}${SYMBOL_SUFFIX}\\s*`); // optional ?/! prefix, lowercase identifiers, optional .n suffix

        for (let i = 0; i < document.lineCount; i++) {
            const text = document.lineAt(i).text; // text content of the current line

            function pushSymbol(match, kind) {
                if (!match) return false;
                const name = match[1];
                const range = new vscode.Range(i, 0, i, text.length);
                symbols.push(new vscode.DocumentSymbol(name, '', kind, range, range));
                return true;
            }

            if (pushSymbol(termRe.exec(text), vscode.SymbolKind.Constant)) continue;
            pushSymbol(ruleRe.exec(text), vscode.SymbolKind.Function);
        }
        return symbols;
    }
}

// Check for unused grammar symbols and report warnings
async function validateTextDocument(document, diagnosticCollection) {
    if (document.languageId !== 'lark') return;

    // Collect definitions via DocumentSymbolProvider
    const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri) || [];
    // Add imported terminals to symbols list
    const importRe = /^\s*%import[^A-Z0-9_]*([A-Z0-9_]+)/;
    for (let i = 0; i < document.lineCount; i++) {
        const lineText = document.lineAt(i).text;
        const importMatch = importRe.exec(lineText);
        if (importMatch) {
            const name = importMatch[1];
            const kind = vscode.SymbolKind.Constant;
            const range = new vscode.Range(i, 0, i, lineText.length);
            symbols.push(new vscode.DocumentSymbol(name, '', kind, range, range));
        }
    }
    /**
     * Mapping of symbol names to their definition lines and usage status.
     *
     * Example: { 'MyTerminal': { line: 5, used: true } }
     */
    const defs = {};
    (function flatten(list) {
        for (const sym of list) {
            defs[sym.name] = { line: sym.range.start.line, used: false };
            if (sym.children && sym.children.length) flatten(sym.children);
        }
    })(symbols);
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

    // Detect unused symbols and report warnings
    const diagnostics = [];
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

    // Detect undefined symbols and report errors
    const termRe = new RegExp(`${SYMBOL_PREFIX}${TERM_BODY}${SYMBOL_SUFFIX}\\s*:`);
    const ruleRe = new RegExp(`${SYMBOL_PREFIX}${RULE_BODY}${SYMBOL_SUFFIX}\\s*:`);
    for (let i = 0; i < document.lineCount; i++) {
        const text = document.lineAt(i).text;
        // skip directive lines and comments
        if (text.trim().startsWith('%')) continue;
        if (text.trim().startsWith('//')) continue;

        let searchText = text;
        const termDefMatch = termRe.exec(text);
        const ruleDefMatch = ruleRe.exec(text);
        const defHeadMatch = /^\s*([^:\s]+)\s*:/.exec(text); // match text before ':'
        let offset = 0;
        if (termDefMatch || ruleDefMatch) {
            const colonIndex = text.indexOf(':');
            if (colonIndex >= 0) {
                offset = colonIndex + 1;
                searchText = text.slice(offset);
            }
        } else if (defHeadMatch) {
            // Report error for invalid definition head before ':'
            const head = defHeadMatch[1];
            const start = text.indexOf(head);
            const end = start + head.length;
            const range = new vscode.Range(i, start, i, end);
            diagnostics.push(new vscode.Diagnostic(range, `Invalid definition name '${head}'`, vscode.DiagnosticSeverity.Error));
        }

        // strip literal strings in quotes
        searchText = searchText.replace(/"[^"]*"/g, (match) => ' '.repeat(match.length));
        // strip comments and aliases
        searchText = searchText.split(/\/\/|->/)[0];
        // strip regex
        searchText = searchText.replace(/(\/(?:\\.|[^\/\\])*\/[gimsuy]*)/g, (match) => ' '.repeat(match.length));

        /**
         * Search for occurrences of a given regex pattern in the current line's text content,
         * and report errors for any undefined symbols found.
         *
         * @param {RegExp} usageRe - Regex pattern to search for. It should have one capture group
         *   that matches the symbol name.
         * @param {string} type - Whether the symbol is a terminal or rule.
         */
        function checkUsages(usageRe, type) {
            let usageMatch;
            while ((usageMatch = usageRe.exec(searchText)) !== null) {
                const name = usageMatch[1];
                if (type === 'rule' && name === 'start') {
                    continue;
                }
                if (!defs.hasOwnProperty(name)) {
                    const realStart = offset + usageMatch.index;
                    const range = new vscode.Range(i, realStart, i, realStart + name.length);
                    const message = type === 'terminal'
                        ? `Undefined terminal '${name}'`
                        : `Undefined rule '${name}'`;
                    diagnostics.push(new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error));
                }
            }
        }
        checkUsages(new RegExp(`\\b${TERM_BODY}${SYMBOL_SUFFIX}\\b`, 'g'), 'terminal');
        checkUsages(new RegExp(`\\b${RULE_BODY}${SYMBOL_SUFFIX}\\b`, 'g'), 'rule');
    }
    diagnosticCollection.set(document.uri, diagnostics);
}

function deactivate() { }

module.exports = { activate, deactivate };
