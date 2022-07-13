/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve } from 'path';
import { TableOfContents } from '../tableOfContents';
import { getLine, ITextDocument } from '../types/textDocument';
import { Schemes } from '../util/schemes';
import { MdLinkProvider } from './documentLinks';
import * as lsp from 'vscode-languageserver-types';
import { FileStat, getWorkspaceFolder, IWorkspace, resolveUriToMarkdownFile } from '../workspace';
import { IMdParser } from '../parser';
import type { CancellationToken, CompletionContext } from 'vscode-languageserver-protocol';
import { makeRange } from '../types/range';
import { URI, Utils } from 'vscode-uri';
import { translatePosition } from '../types/position';

enum CompletionContextKind {
	/** `[...](|)` */
	Link,

	/** `[...][|]` */
	ReferenceLink,

	/** `[]: |` */
	LinkDefinition,
}

interface AnchorContext {
	/**
	 * Link text before the `#`.
	 *
	 * For `[text](xy#z|abc)` this is `xy`.
	 */
	readonly beforeAnchor: string;

	/**
	 * Text of the anchor before the current position.
	 *
	 * For `[text](xy#z|abc)` this is `z`.
	 */
	readonly anchorPrefix: string;
}

interface PathCompletionContext {
	readonly kind: CompletionContextKind;

	/**
	 * Text of the link before the current position
	 *
	 * For `[text](xy#z|abc)` this is `xy#z`.
	 */
	readonly linkPrefix: string;

	/**
	 * Position of the start of the link.
	 *
	 * For `[text](xy#z|abc)` this is the position before `xy`.
	 */
	readonly linkTextStartPosition: lsp.Position;

	/**
	 * Text of the link after the current position.
	 *
	 * For `[text](xy#z|abc)` this is `abc`.
	 */
	readonly linkSuffix: string;

	/**
	 * Info if the link looks like it is for an anchor: `[](#header)`
	 */
	readonly anchorInfo?: AnchorContext;

	/**
	 * Indicates that the completion does not require encoding.
	 */
	readonly skipEncoding?: boolean;
}

function tryDecodeUriComponent(str: string): string {
	try {
		return decodeURIComponent(str);
	} catch {
		return str;
	}
}

/**
 * Adds path completions in markdown files.
 */
export class MdPathCompletionProvider {

	constructor(
		private readonly workspace: IWorkspace,
		private readonly parser: IMdParser,
		private readonly linkProvider: MdLinkProvider,
	) { }

	public async provideCompletionItems(document: ITextDocument, position: lsp.Position, _context: CompletionContext, _token: CancellationToken): Promise<lsp.CompletionItem[]> {
		const context = this.getPathCompletionContext(document, position);
		if (!context) {
			return [];
		}

		switch (context.kind) {
			case CompletionContextKind.ReferenceLink: {
				const items: lsp.CompletionItem[] = [];
				for await (const item of this.provideReferenceSuggestions(document, position, context)) {
					items.push(item);
				}
				return items;
			}

			case CompletionContextKind.LinkDefinition:
			case CompletionContextKind.Link: {
				const items: lsp.CompletionItem[] = [];

				const isAnchorInCurrentDoc = context.anchorInfo && context.anchorInfo.beforeAnchor.length === 0;

				// Add anchor #links in current doc
				if (context.linkPrefix.length === 0 || isAnchorInCurrentDoc) {
					const insertRange = makeRange(context.linkTextStartPosition, position);
					for await (const item of this.provideHeaderSuggestions(document, position, context, insertRange)) {
						items.push(item);
					}
				}

				if (!isAnchorInCurrentDoc) {
					if (context.anchorInfo) { // Anchor to a different document
						const rawUri = this.resolveReference(document, context.anchorInfo.beforeAnchor);
						if (rawUri) {
							const otherDoc = await resolveUriToMarkdownFile(this.workspace, rawUri);
							if (otherDoc) {
								const anchorStartPosition = translatePosition(position, { characterDelta: -(context.anchorInfo.anchorPrefix.length + 1) });
								const range = makeRange(anchorStartPosition, position);
								for await (const item of this.provideHeaderSuggestions(otherDoc, position, context, range)) {
									items.push(item);
								}
							}
						}
					} else { // Normal path suggestions
						for await (const item of this.providePathSuggestions(document, position, context)) {
							items.push(item);
						}
					}
				}

				return items;
			}
		}
	}

	/// [...](...|
	private readonly linkStartPattern = /\[([^\]]*?)\]\(\s*(<[^\>\)]*|[^\s\(\)]*)$/;

	/// [...][...|
	private readonly referenceLinkStartPattern = /\[([^\]]*?)\]\[\s*([^\s\(\)]*)$/;

	/// [id]: |
	private readonly definitionPattern = /^\s*\[[\w\-]+\]:\s*([^\s]*)$/m;

	private getPathCompletionContext(document: ITextDocument, position: lsp.Position): PathCompletionContext | undefined {
		const line = getLine(document, position.line);

		const linePrefixText = line.slice(0, position.character);
		const lineSuffixText = line.slice(position.character);

		const linkPrefixMatch = linePrefixText.match(this.linkStartPattern);
		if (linkPrefixMatch) {
			const isAngleBracketLink = linkPrefixMatch[2].startsWith('<');
			const prefix = linkPrefixMatch[2].slice(isAngleBracketLink ? 1 : 0);
			if (this.refLooksLikeUrl(prefix)) {
				return undefined;
			}

			const suffix = lineSuffixText.match(/^[^\)\s][^\)\s\>]*/);
			return {
				kind: CompletionContextKind.Link,
				linkPrefix: tryDecodeUriComponent(prefix),
				linkTextStartPosition: translatePosition(position, { characterDelta: -prefix.length }),
				linkSuffix: suffix ? suffix[0] : '',
				anchorInfo: this.getAnchorContext(prefix),
				skipEncoding: isAngleBracketLink,
			};
		}

		const definitionLinkPrefixMatch = linePrefixText.match(this.definitionPattern);
		if (definitionLinkPrefixMatch) {
			const isAngleBracketLink = definitionLinkPrefixMatch[1].startsWith('<');
			const prefix = definitionLinkPrefixMatch[1].slice(isAngleBracketLink ? 1 : 0);
			if (this.refLooksLikeUrl(prefix)) {
				return undefined;
			}

			const suffix = lineSuffixText.match(/^[^\s]*/);
			return {
				kind: CompletionContextKind.LinkDefinition,
				linkPrefix: tryDecodeUriComponent(prefix),
				linkTextStartPosition: translatePosition(position, { characterDelta: -prefix.length }),
				linkSuffix: suffix ? suffix[0] : '',
				anchorInfo: this.getAnchorContext(prefix),
				skipEncoding: isAngleBracketLink,
			};
		}

		const referenceLinkPrefixMatch = linePrefixText.match(this.referenceLinkStartPattern);
		if (referenceLinkPrefixMatch) {
			const prefix = referenceLinkPrefixMatch[2];
			const suffix = lineSuffixText.match(/^[^\]\s]*/);
			return {
				kind: CompletionContextKind.ReferenceLink,
				linkPrefix: prefix,
				linkTextStartPosition: translatePosition(position, { characterDelta: -prefix.length }),
				linkSuffix: suffix ? suffix[0] : '',
			};
		}

		return undefined;
	}

	/**
	 * Check if {@param ref} looks like a 'http:' style url.
	 */
	private refLooksLikeUrl(prefix: string): boolean {
		return /^\s*[\w\d\-]+:/.test(prefix);
	}

	private getAnchorContext(prefix: string): AnchorContext | undefined {
		const anchorMatch = prefix.match(/^(.*)#([\w\d\-]*)$/);
		if (!anchorMatch) {
			return undefined;
		}
		return {
			beforeAnchor: anchorMatch[1],
			anchorPrefix: anchorMatch[2],
		};
	}

	private async *provideReferenceSuggestions(document: ITextDocument, position: lsp.Position, context: PathCompletionContext): AsyncIterable<lsp.CompletionItem> {
		const insertionRange = makeRange(context.linkTextStartPosition, position);
		const replacementRange = makeRange(insertionRange.start, translatePosition(position, { characterDelta: context.linkSuffix.length }));

		const { definitions } = await this.linkProvider.getLinks(document);
		for (const [_, def] of definitions) {
			yield {
				kind: lsp.CompletionItemKind.Reference,
				label: def.ref.text,
				textEdit: {
					newText: def.ref.text,
					insert: insertionRange,
					replace: replacementRange,
				}
			};
		}
	}

	private async *provideHeaderSuggestions(document: ITextDocument, position: lsp.Position, context: PathCompletionContext, insertionRange: lsp.Range): AsyncIterable<lsp.CompletionItem> {
		// TODO: notebook support
		// const toc = await TableOfContents.createForDocumentOrNotebook(this.parser, document);
		const toc = await TableOfContents.create(this.parser, document);
		for (const entry of toc.entries) {
			const replacementRange = makeRange(insertionRange.start, translatePosition(position, { characterDelta: context.linkSuffix.length }));
			const label = '#' + decodeURIComponent(entry.slug.value);
			yield {
				kind: lsp.CompletionItemKind.Reference,
				label,
				textEdit: {
					newText: label,
					insert: insertionRange,
					replace: replacementRange,
				},
			};
		}
	}

	private async *providePathSuggestions(document: ITextDocument, position: lsp.Position, context: PathCompletionContext): AsyncIterable<lsp.CompletionItem> {
		const valueBeforeLastSlash = context.linkPrefix.substring(0, context.linkPrefix.lastIndexOf('/') + 1); // keep the last slash

		const parentDir = this.resolveReference(document, valueBeforeLastSlash || '.');
		if (!parentDir) {
			return;
		}

		const pathSegmentStart = translatePosition(position, { characterDelta: valueBeforeLastSlash.length - context.linkPrefix.length });
		const insertRange = makeRange(pathSegmentStart, position);

		const pathSegmentEnd = translatePosition(position, { characterDelta: context.linkSuffix.length });
		const replacementRange = makeRange(pathSegmentStart, pathSegmentEnd);

		let dirInfo: [string, FileStat][];
		try {
			dirInfo = await this.workspace.readDirectory(parentDir);
		} catch {
			return;
		}

		for (const [name, type] of dirInfo) {
			// Exclude paths that start with `.`
			if (name.startsWith('.')) {
				continue;
			}

			const isDir = !!type.isDirectory;
			const newText = (context.skipEncoding ? name : encodeURIComponent(name)) + (isDir ? '/' : '');
			yield {
				label: isDir ? name + '/' : name,
				kind: isDir ? lsp.CompletionItemKind.Folder : lsp.CompletionItemKind.File,
				textEdit: {
					newText,
					insert: insertRange,
					replace: replacementRange,
				},
				command: isDir ? { command: 'editor.action.triggerSuggest', title: '' } : undefined,
			};
		}
	}

	private resolveReference(document: ITextDocument, ref: string): URI | undefined {
		const docUri = this.getFileUriOfTextDocument(document);

		if (ref.startsWith('/')) {
			const workspaceFolder = getWorkspaceFolder(this.workspace, docUri);
			if (workspaceFolder) {
				return Utils.joinPath(workspaceFolder, ref);
			} else {
				return this.resolvePath(docUri, ref.slice(1));
			}
		}

		return this.resolvePath(docUri, ref);
	}

	private resolvePath(root: URI, ref: string): URI | undefined {
		try {
			if (root.scheme === Schemes.file) {
				return URI.file(resolve(dirname(root.fsPath), ref));
			} else {
				return root.with({
					path: resolve(dirname(root.path), ref),
				});
			}
		} catch {
			return undefined;
		}
	}

	private getFileUriOfTextDocument(document: ITextDocument): URI {
		// TODO: notebook support
		// if (document.uri.scheme === 'vscode-notebook-cell') {
		// 	const notebook = lsp.workspace.notebookDocuments
		// 		.find(notebook => notebook.getCells().some(cell => cell.document === document));

		// 	if (notebook) {
		// 		return notebook.uri;
		// 	}
		// }

		return URI.parse(document.uri);
	}
}
