/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken, CompletionContext } from 'vscode-languageserver';
import * as lsp from 'vscode-languageserver-types';
import { URI } from 'vscode-uri';
import { getLsConfiguration } from './config';
import { MdDefinitionProvider } from './languageFeatures/definitions';
import { MdLinkProvider } from './languageFeatures/documentLinks';
import { MdDocumentSymbolProvider } from './languageFeatures/documentSymbols';
import { MdFoldingProvider } from './languageFeatures/folding';
import { MdPathCompletionProvider } from './languageFeatures/pathCompletions';
import { MdReferencesProvider } from './languageFeatures/references';
import { MdRenameProvider } from './languageFeatures/rename';
import { MdSelectionRangeProvider } from './languageFeatures/smartSelect';
import { MdWorkspaceSymbolProvider } from './languageFeatures/workspaceSymbols';
import { ILogger } from './logging';
import { IMdParser } from './parser';
import { MdTableOfContentsProvider } from './tableOfContents';
import { ITextDocument } from './types/textDocument';
import { IWorkspace } from './workspace';

export { MdLink } from './languageFeatures/documentLinks';
export { ILogger } from './logging';
export { IMdParser, Token } from './parser';
export { githubSlugifier, ISlugifier } from './slugify';
export { ITextDocument } from './types/textDocument';
export { FileStat, IWorkspace } from './workspace';

// Language service

export interface IMdLanguageService {

	/**
	 * Get all links of a markdown file.
	 *
	 * Note that you must invoke {@link resolveDocumentLink} on each link before executing the link.
	 */
	getDocumentLinks(document: ITextDocument, token: CancellationToken): Promise<lsp.DocumentLink[]>;

	/**
	 * Resolves a link from {@link getDocumentLinks}.
	 *
	 * This fills in the target on the link.
	 *
	 * @return The resolved link or `undefined` if the passed in link should be used
	 */
	resolveDocumentLink(link: lsp.DocumentLink, token: CancellationToken): Promise<lsp.DocumentLink | undefined>;

	/**
	 * Get the symbols of a markdown file.
	 *
	 * This currently returns the headers in the file.
	 */
	getDocumentSymbols(document: ITextDocument, token: CancellationToken): Promise<lsp.DocumentSymbol[]>;

	/**
	 * Get the folding ranges of a markdown file.
	 *
	 * This returns folding ranges for:
	 *
	 * - Header sections
	 * - Regions
	 * - List and other block element
	 */
	getFoldingRanges(document: ITextDocument, token: CancellationToken): Promise<lsp.FoldingRange[]>;

	/**
	 * Get the selection ranges of a markdown file.
	 */
	getSelectionRanges(document: ITextDocument, positions: lsp.Position[], token: CancellationToken): Promise<lsp.SelectionRange[] | undefined>;

	/**
	 * Get the symbols for all markdown files in the current workspace.
	 */
	getWorkspaceSymbols(query: string, token: CancellationToken): Promise<lsp.WorkspaceSymbol[]>;

	/**
	 * Get completions items at a given position in a markdown file.
	 */
	getCompletionItems(document: ITextDocument, position: lsp.Position, context: CompletionContext, token: CancellationToken): Promise<lsp.CompletionItem[]>;

	/**
	 * Get the references to a symbol at the current location.
	 *
	 * Supports finding references to headers and links.
	 */
	getReferences(document: ITextDocument, position: lsp.Position, context: lsp.ReferenceContext, token: CancellationToken): Promise<lsp.Location[]>;

	/**
	 * Get the references to a given file.
	 */
	getFileReferences(resource: URI, token: CancellationToken): Promise<lsp.Location[]>;

	/**
	 * Get the definition of the symbol at the current location.
	 *
	 * Supports finding headers from fragments links or reference link definitions.
	 */
	getDefinition(document: ITextDocument, position: lsp.Position, token: CancellationToken): Promise<lsp.Definition | undefined>;

	prepareRename(document: ITextDocument, position: lsp.Position, token: CancellationToken): Promise<{ range: lsp.Range; placeholder: string } | undefined>;

	getRenameEdit(document: ITextDocument, position: lsp.Position, nameName: string, token: CancellationToken): Promise<lsp.WorkspaceEdit | undefined>;

	/**
	 * Dispose of the language service, freeing any associated resources.
	 */
	dispose(): void;
}

export interface LanguageServiceInitialization {
	// Services

	readonly workspace: IWorkspace;
	readonly parser: IMdParser;
	readonly logger: ILogger;

	// Config

	/**
	 * List of file extensions should be considered as markdown.
	 *
	 * These should not include the leading `.`.
	 *
	 * @default ['md']
	 */
	readonly markdownFileExtensions?: readonly string[];
}

/**
 * Create a new instance of the language service.
 */
export function createLanguageService(init: LanguageServiceInitialization): IMdLanguageService {
	const config = getLsConfiguration(init);
	const logger = init.logger;

	const tocProvider = new MdTableOfContentsProvider(init.parser, init.workspace, logger);
	const docSymbolProvider = new MdDocumentSymbolProvider(tocProvider, logger);
	const smartSelectProvider = new MdSelectionRangeProvider(init.parser, tocProvider, logger);
	const foldingProvider = new MdFoldingProvider(init.parser, tocProvider, logger);
	const workspaceSymbolProvider = new MdWorkspaceSymbolProvider(init.workspace, docSymbolProvider);
	const linkProvider = new MdLinkProvider(init.parser, init.workspace, tocProvider, logger);
	const pathCompletionProvider = new MdPathCompletionProvider(init.workspace, init.parser, linkProvider);
	const referencesProvider = new MdReferencesProvider(config, init.parser, init.workspace, tocProvider, logger);
	const definitionsProvider = new MdDefinitionProvider(referencesProvider);
	const renameProvider = new MdRenameProvider(init.workspace, referencesProvider, init.parser.slugifier);

	return Object.freeze<IMdLanguageService>({
		dispose: () => {
			tocProvider.dispose();
			workspaceSymbolProvider.dispose();
			linkProvider.dispose();
			referencesProvider.dispose();
		},
		getDocumentLinks: linkProvider.provideDocumentLinks.bind(linkProvider),
		resolveDocumentLink: linkProvider.resolveDocumentLink.bind(linkProvider),
		getDocumentSymbols: docSymbolProvider.provideDocumentSymbols.bind(docSymbolProvider),
		getFoldingRanges: foldingProvider.provideFoldingRanges.bind(foldingProvider),
		getSelectionRanges: smartSelectProvider.provideSelectionRanges.bind(smartSelectProvider),
		getWorkspaceSymbols: workspaceSymbolProvider.provideWorkspaceSymbols.bind(workspaceSymbolProvider),
		getCompletionItems: pathCompletionProvider.provideCompletionItems.bind(pathCompletionProvider),
		getReferences: referencesProvider.provideReferences.bind(referencesProvider),
		getFileReferences: async (resource: URI, token: CancellationToken): Promise<lsp.Location[]> => {
			return (await referencesProvider.getReferencesToFileInWorkspace(resource, token)).map(x => x.location);
		},
		getDefinition: definitionsProvider.provideDefinition.bind(definitionsProvider),
		prepareRename: renameProvider.prepareRename.bind(renameProvider),
		getRenameEdit: renameProvider.provideRenameEdits.bind(renameProvider),
	});
}
