// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { DOMUtils, showErrorMessage } from '@jupyterlab/apputils';
import { PageConfig, PathExt } from '@jupyterlab/coreutils';
import { renameFile } from '@jupyterlab/docmanager';
import type { ITranslator, TranslationBundle } from '@jupyterlab/translation';
import { nullTranslator } from '@jupyterlab/translation';
import {
  addIcon,
  ellipsesIcon,
  homeIcon as preferredIcon,
  folderIcon as rootIcon
} from '@jupyterlab/ui-components';
import { JSONExt } from '@lumino/coreutils';
import type { Drag } from '@lumino/dragdrop';
import type { Message } from '@lumino/messaging';
import { Widget } from '@lumino/widgets';
import type { FileBrowserModel } from './model';

/**
 * The class name added to the breadcrumb node.
 */
const BREADCRUMB_CLASS = 'jp-BreadCrumbs';

/**
 * The class name for the breadcrumbs home node
 */
const BREADCRUMB_ROOT_CLASS = 'jp-BreadCrumbs-home';

/**
 * The class name for the breadcrumbs preferred node
 */
const BREADCRUMB_PREFERRED_CLASS = 'jp-BreadCrumbs-preferred';

/**
 * The class name added to the breadcrumb node.
 */
const BREADCRUMB_ITEM_CLASS = 'jp-BreadCrumbs-item';

/**
 * The class name for the breadcrumbs ellipsis node
 */
const BREADCRUMB_ELLIPSIS_CLASS = 'jp-BreadCrumbs-ellipsis';

/**
 * The mime type for a contents drag object.
 */
const CONTENTS_MIME = 'application/x-jupyter-icontents';

/**
 * The class name added to drop targets.
 */
const DROP_TARGET_CLASS = 'jp-mod-dropTarget';

const BREADCRUMB_INPUT_MODE_CLASS = 'jp-mod-inputMode';
const BREADCRUMB_ADDER_CLASS = 'jp-BreadCrumbs-adder';
const BREADCRUMB_INPUT_CLASS = 'jp-BreadCrumbs-input';
const BREADCRUMB_SUGGESTIONS_CLASS = 'jp-BreadCrumbs-suggestions';
const BREADCRUMB_SUGGESTION_CLASS = 'jp-BreadCrumbs-suggestion';

/**
 * A component that renders a path input with directory autocomplete for quick
 * navigation. It owns an adder button (the trigger), a text input, and a
 * suggestions dropdown.
 *
 * Interaction is communicated outward via callbacks rather than direct
 * coupling to the parent widget.
 */
class PathNavigator {
  constructor(options: PathNavigator.IOptions) {
    this._options = options;

    this._adderNode = addIcon.element({
      className: `${BREADCRUMB_ITEM_CLASS} ${BREADCRUMB_ADDER_CLASS}`,
      tag: 'span',
      title: 'Go to path…',
      stylesheet: 'breadCrumb'
    });

    this._inputNode = document.createElement('input');
    this._inputNode.type = 'text';
    this._inputNode.className = BREADCRUMB_INPUT_CLASS;
    this._inputNode.placeholder = 'Type a path…';

    this._suggestionsNode = document.createElement('ul');
    this._suggestionsNode.className = BREADCRUMB_SUGGESTIONS_CLASS;
    this._suggestionsNode.style.display = 'none';
  }

  /**
   * The button that triggers path input mode.
   */
  get adderNode(): HTMLElement {
    return this._adderNode;
  }

  /**
   * The text input element.
   */
  get inputNode(): HTMLInputElement {
    return this._inputNode;
  }

  /**
   * The suggestions dropdown element.
   */
  get suggestionsNode(): HTMLElement {
    return this._suggestionsNode;
  }

  /**
   * Whether path input mode is currently active.
   */
  get isActive(): boolean {
    return this._isActive;
  }

  /**
   * Attach DOM event listeners.
   */
  attach(): void {
    this._adderNode.addEventListener('click', this._enterInputMode);
    this._inputNode.addEventListener('input', this);
    this._inputNode.addEventListener('keydown', this);
    this._inputNode.addEventListener('blur', this);
    // Use mousedown (not click) so we can preventDefault() before blur fires.
    this._suggestionsNode.addEventListener('mousedown', this);
  }

  /**
   * Remove DOM event listeners.
   */
  detach(): void {
    this._adderNode.removeEventListener('click', this._enterInputMode);
    this._inputNode.removeEventListener('input', this);
    this._inputNode.removeEventListener('keydown', this);
    this._inputNode.removeEventListener('blur', this);
    this._suggestionsNode.removeEventListener('mousedown', this);
  }

  handleEvent(event: Event): void {
    switch (event.type) {
      case 'input':
        void this._updateSuggestions(this._inputNode.value);
        break;
      case 'keydown':
        this._evtKeydown(event as KeyboardEvent);
        break;
      case 'blur':
        this._exitInputMode();
        break;
      case 'mousedown':
        this._evtSuggestionMousedown(event as MouseEvent);
        break;
      default:
        break;
    }
  }

  /**
   * Enter path input mode: show the input, prefill with the current path, and
   * immediately load suggestions.
   */
  private _enterInputMode = (): void => {
    this._isActive = true;
    this._options.onActivate();

    const currentPath = this._options.getCurrentPath();
    const prefill = currentPath ? currentPath + '/' : '';
    this._inputNode.value = prefill;
    this._inputNode.focus();
    this._inputNode.setSelectionRange(prefill.length, prefill.length);

    void this._updateSuggestions(prefill);
  };

  /**
   * Exit path input mode and hide the suggestions dropdown.
   */
  private _exitInputMode(): void {
    if (!this._isActive) {
      return;
    }
    this._isActive = false;
    this._suggestionsNode.style.display = 'none';
    this._options.onDeactivate();
  }

  /**
   * Fetch and display directory suggestions for the given input value.
   */
  private async _updateSuggestions(inputValue: string): Promise<void> {
    const lastSlash = inputValue.lastIndexOf('/');
    const rawDirPart = lastSlash >= 0 ? inputValue.slice(0, lastSlash) : '';
    // Strip any leading slash — contents.get expects paths without a leading
    // slash (relative to the Jupyter server root).
    const dirPart = rawDirPart.startsWith('/')
      ? rawDirPart.slice(1)
      : rawDirPart;
    const searchPart =
      lastSlash >= 0 ? inputValue.slice(lastSlash + 1) : inputValue;

    // Only re-fetch when the directory portion of the input changes.
    if (dirPart !== this._suggestionDirPath) {
      this._suggestionDirPath = dirPart;
      this._suggestions = [];
      try {
        const items = await this._options.getDirectoryContents(dirPart || '/');
        this._suggestions = items
          .filter(item => item.type === 'directory')
          .map(item => (dirPart ? `${dirPart}/${item.name}` : item.name));
      } catch {
        this._suggestions = [];
      }
    }

    const lower = searchPart.toLowerCase();
    const filtered = this._suggestions.filter(s => {
      const base = s.slice(s.lastIndexOf('/') + 1);
      return base.toLowerCase().startsWith(lower);
    });

    this._activeSuggestionIndex = -1;
    this._renderSuggestions(filtered);
  }

  /**
   * Re-render the suggestions list from the given paths.
   */
  private _renderSuggestions(suggestions: string[]): void {
    this._suggestionsNode.replaceChildren();
    if (suggestions.length === 0) {
      this._suggestionsNode.style.display = 'none';
      return;
    }
    for (const path of suggestions) {
      const li = document.createElement('li');
      li.className = BREADCRUMB_SUGGESTION_CLASS;
      li.textContent = path.slice(path.lastIndexOf('/') + 1);
      li.dataset.path = path;
      this._suggestionsNode.appendChild(li);
    }
    this._suggestionsNode.style.display = '';
    this._currentFilteredSuggestions = suggestions;
  }

  /**
   * Handle keyboard navigation and confirmation inside the input.
   */
  private _evtKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case 'Enter':
        this._options.onNavigate(this._inputNode.value);
        this._exitInputMode();
        break;
      case 'Escape':
        this._exitInputMode();
        break;
      case 'Tab':
        event.preventDefault();
        this._acceptSuggestion();
        break;
      case 'ArrowDown':
        event.preventDefault();
        this._navigateSuggestions(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        this._navigateSuggestions(-1);
        break;
      case '/':
        // Defer so the character is already in the input value.
        setTimeout(() => {
          void this._updateSuggestions(this._inputNode.value);
        }, 0);
        break;
      default:
        break;
    }
  }

  /**
   * Handle mousedown on a suggestion item.
   *
   * Using mousedown (before blur) and calling preventDefault() keeps focus on
   * the input, so we can navigate without the blur handler firing first.
   */
  private _evtSuggestionMousedown(event: MouseEvent): void {
    // Prevent the input from losing focus before we process the selection.
    event.preventDefault();
    let target = event.target as HTMLElement;
    while (target && target !== this._suggestionsNode) {
      if (target.classList.contains(BREADCRUMB_SUGGESTION_CLASS)) {
        const path = target.dataset.path;
        if (path) {
          this._options.onNavigate(path);
          this._exitInputMode();
        }
        return;
      }
      target = target.parentElement as HTMLElement;
    }
  }

  /**
   * Move the active suggestion up or down by `direction` steps.
   */
  private _navigateSuggestions(direction: 1 | -1): void {
    const items = Array.from(this._suggestionsNode.children) as HTMLElement[];
    if (items.length === 0) {
      return;
    }

    if (this._activeSuggestionIndex >= 0) {
      items[this._activeSuggestionIndex].classList.remove('jp-mod-active');
    }

    this._activeSuggestionIndex += direction;
    if (this._activeSuggestionIndex < 0) {
      this._activeSuggestionIndex = items.length - 1;
    } else if (this._activeSuggestionIndex >= items.length) {
      this._activeSuggestionIndex = 0;
    }

    const activeItem = items[this._activeSuggestionIndex];
    activeItem.classList.add('jp-mod-active');
    activeItem.scrollIntoView({ block: 'nearest' });

    const path = activeItem.dataset.path;
    if (path) {
      this._inputNode.value = path + '/';
    }
  }

  /**
   * Accept the highlighted suggestion (Tab key).
   * If none is highlighted, complete to the sole match or longest common prefix.
   */
  private _acceptSuggestion(): void {
    const items = Array.from(this._suggestionsNode.children) as HTMLElement[];

    if (
      this._activeSuggestionIndex >= 0 &&
      items[this._activeSuggestionIndex]
    ) {
      const path = items[this._activeSuggestionIndex].dataset.path;
      if (path) {
        this._inputNode.value = path + '/';
        void this._updateSuggestions(this._inputNode.value);
      }
    } else if (this._currentFilteredSuggestions.length === 1) {
      this._inputNode.value = this._currentFilteredSuggestions[0] + '/';
      void this._updateSuggestions(this._inputNode.value);
    } else if (this._currentFilteredSuggestions.length > 1) {
      // Complete to the longest common prefix of all matching names.
      const names = this._currentFilteredSuggestions.map(s =>
        s.slice(s.lastIndexOf('/') + 1)
      );
      let prefix = names[0];
      for (const name of names.slice(1)) {
        let i = 0;
        while (i < prefix.length && i < name.length && prefix[i] === name[i]) {
          i++;
        }
        prefix = prefix.slice(0, i);
      }
      if (prefix) {
        const lastSlash = this._inputNode.value.lastIndexOf('/');
        const dirPart =
          lastSlash >= 0 ? this._inputNode.value.slice(0, lastSlash + 1) : '';
        this._inputNode.value = dirPart + prefix;
        void this._updateSuggestions(this._inputNode.value);
      }
    }
  }

  private _options: PathNavigator.IOptions;
  private _adderNode: HTMLElement;
  private _inputNode: HTMLInputElement;
  private _suggestionsNode: HTMLElement;
  private _isActive = false;
  private _suggestions: string[] = [];
  private _currentFilteredSuggestions: string[] = [];
  private _activeSuggestionIndex = -1;
  private _suggestionDirPath = '';
}

namespace PathNavigator {
  export interface IOptions {
    /**
     * Returns the current local path, used to pre-fill the input on open.
     */
    getCurrentPath: () => string;

    /**
     * Fetch the list of items inside the given directory path.
     */
    getDirectoryContents: (
      path: string
    ) => Promise<Array<{ name: string; type: string }>>;

    /**
     * Called when the user confirms a path (Enter or suggestion click).
     * The path value is the raw string from the input; normalization is the
     * caller's responsibility.
     */
    onNavigate: (path: string) => void;

    /**
     * Called when path input mode becomes active.
     */
    onActivate: () => void;

    /**
     * Called when path input mode becomes inactive.
     */
    onDeactivate: () => void;
  }
}

/**
 * A class which hosts folder breadcrumbs.
 */
export class BreadCrumbs extends Widget {
  /**
   * Construct a new file browser crumb widget.
   *
   * @param options Constructor options.
   */
  constructor(options: BreadCrumbs.IOptions) {
    super();
    this.translator = options.translator || nullTranslator;
    this._trans = this.translator.load('jupyterlab');
    this._model = options.model;
    this._fullPath = options.fullPath || false;
    this._minimumLeftItems = options.minimumLeftItems ?? 0;
    this._minimumRightItems = options.minimumRightItems ?? 2;
    this.addClass(BREADCRUMB_CLASS);
    this._crumbs = Private.createCrumbs();
    const hasPreferred = PageConfig.getOption('preferredPath');
    this._hasPreferred = hasPreferred && hasPreferred !== '/' ? true : false;
    if (this._hasPreferred) {
      this.node.appendChild(this._crumbs[Private.Crumb.Preferred]);
    }
    this.node.appendChild(this._crumbs[Private.Crumb.Home]);
    this._model.refreshed.connect(this.update, this);

    const contents = this._model.manager.services.contents;
    this._pathNavigator = new PathNavigator({
      getCurrentPath: () => contents.localPath(this._model.path),
      getDirectoryContents: async path => {
        const result = await contents.get(path, { content: true });
        if (result.type === 'directory' && Array.isArray(result.content)) {
          return result.content as Array<{ name: string; type: string }>;
        }
        return [];
      },
      onNavigate: path => this._commitNavigation(path),
      onActivate: () => {
        this.node.classList.add(BREADCRUMB_INPUT_MODE_CLASS);
      },
      onDeactivate: () => {
        this.node.classList.remove(BREADCRUMB_INPUT_MODE_CLASS);
        // Force re-render of crumbs.
        this._previousState = null;
        this.update();
      }
    });

    this.node.appendChild(this._pathNavigator.inputNode);
    this.node.appendChild(this._pathNavigator.suggestionsNode);
  }

  /**
   * Handle the DOM events for the bread crumbs.
   *
   * @param event - The DOM event sent to the widget.
   *
   * #### Notes
   * This method implements the DOM `EventListener` interface and is
   * called in response to events on the panel's DOM node. It should
   * not be called directly by user code.
   */
  handleEvent(event: Event): void {
    switch (event.type) {
      case 'click':
        this._evtClick(event as MouseEvent);
        break;
      case 'lm-dragenter':
        this._evtDragEnter(event as Drag.Event);
        break;
      case 'lm-dragleave':
        this._evtDragLeave(event as Drag.Event);
        break;
      case 'lm-dragover':
        this._evtDragOver(event as Drag.Event);
        break;
      case 'lm-drop':
        this._evtDrop(event as Drag.Event);
        break;
      default:
        return;
    }
  }

  /**
   * Whether to show the full path in the breadcrumbs
   */
  get fullPath(): boolean {
    return this._fullPath;
  }

  set fullPath(value: boolean) {
    this._fullPath = value;
  }

  /**
   * Number of items to show on left of ellipsis
   */
  get minimumLeftItems(): number {
    return this._minimumLeftItems;
  }

  set minimumLeftItems(value: number) {
    this._minimumLeftItems = value;
  }

  /**
   * Number of items to show on right of ellipsis
   */
  get minimumRightItems(): number {
    return this._minimumRightItems;
  }

  set minimumRightItems(value: number) {
    this._minimumRightItems = value;
  }

  /**
   * A message handler invoked on an `'after-attach'` message.
   */
  protected onAfterAttach(msg: Message): void {
    super.onAfterAttach(msg);
    this.update();
    const node = this.node;
    node.addEventListener('click', this);
    node.addEventListener('lm-dragenter', this);
    node.addEventListener('lm-dragleave', this);
    node.addEventListener('lm-dragover', this);
    node.addEventListener('lm-drop', this);
    this._pathNavigator.attach();
  }

  /**
   * A message handler invoked on a `'before-detach'` message.
   */
  protected onBeforeDetach(msg: Message): void {
    super.onBeforeDetach(msg);
    const node = this.node;
    node.removeEventListener('click', this);
    node.removeEventListener('lm-dragenter', this);
    node.removeEventListener('lm-dragleave', this);
    node.removeEventListener('lm-dragover', this);
    node.removeEventListener('lm-drop', this);
    this._pathNavigator.detach();
  }

  /**
   * A handler invoked on an `'update-request'` message.
   */
  protected onUpdateRequest(msg: Message): void {
    // Don't re-render while the user is typing in the input.
    if (this._pathNavigator.isActive) {
      return;
    }

    // Update the breadcrumb list.
    const contents = this._model.manager.services.contents;
    const localPath = contents.localPath(this._model.path);
    const state = {
      path: localPath,
      hasPreferred: this._hasPreferred,
      fullPath: this._fullPath,
      minimumLeftItems: this._minimumLeftItems,
      minimumRightItems: this._minimumRightItems
    };
    if (this._previousState && JSONExt.deepEqual(state, this._previousState)) {
      return;
    }
    this._previousState = state;
    Private.updateCrumbs(this._crumbs, state);

    // Re-append persistent nodes: Private.updateCrumbs() removes all children
    // after the first one on every render, so the navigator nodes get detached
    // from the DOM. Re-append them so they are always present.
    this.node.appendChild(this._pathNavigator.inputNode);
    this.node.appendChild(this._pathNavigator.suggestionsNode);
    this.node.appendChild(this._pathNavigator.adderNode);
  }

  /**
   * Handle the `'click'` event for the widget.
   */
  private _evtClick(event: MouseEvent): void {
    // Do nothing if it's not a left mouse press.
    if (event.button !== 0) {
      return;
    }

    // Find a valid click target.
    let node = event.target as HTMLElement;
    while (node && node !== this.node) {
      if (node.classList.contains(BREADCRUMB_PREFERRED_CLASS)) {
        const preferredPath = PageConfig.getOption('preferredPath');
        const path = preferredPath ? '/' + preferredPath : preferredPath;
        this._model
          .cd(path)
          .catch(error =>
            showErrorMessage(this._trans.__('Open Error'), error)
          );

        // Stop the event propagation.
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (node.classList.contains(BREADCRUMB_ADDER_CLASS)) {
        // Adder button — handled by PathNavigator; skip navigation.
        return;
      }
      if (
        node.classList.contains(BREADCRUMB_ITEM_CLASS) ||
        node.classList.contains(BREADCRUMB_ROOT_CLASS)
      ) {
        let destination: string | undefined;
        if (node.classList.contains(BREADCRUMB_ROOT_CLASS)) {
          destination = '/';
        } else {
          destination = `/${node.dataset.path}`;
        }
        if (destination) {
          this._model
            .cd(destination)
            .catch(error =>
              showErrorMessage(this._trans.__('Open Error'), error)
            );
        }

        // Stop the event propagation.
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      node = node.parentElement as HTMLElement;
    }
  }

  /**
   * Handle the `'lm-dragenter'` event for the widget.
   */
  private _evtDragEnter(event: Drag.Event): void {
    if (event.mimeData.hasData(CONTENTS_MIME)) {
      const breadcrumbElements = this._getBreadcrumbElements();
      let index = -1;
      let target = event.target as HTMLElement;
      while (target && target !== this.node) {
        index = breadcrumbElements.indexOf(target);
        if (index !== -1) {
          break;
        }
        target = target.parentElement as HTMLElement;
      }
      if (index !== -1) {
        const hitElement = breadcrumbElements[index];
        // Don't allow dropping on the current path
        const currentPath = this._model.manager.services.contents.localPath(
          this._model.path
        );
        if (hitElement.dataset.path !== currentPath) {
          hitElement.classList.add(DROP_TARGET_CLASS);
          event.preventDefault();
          event.stopPropagation();
        }
      }
    }
  }

  /**
   * Handle the `'lm-dragleave'` event for the widget.
   */
  private _evtDragLeave(event: Drag.Event): void {
    event.preventDefault();
    event.stopPropagation();
    const dropTarget = DOMUtils.findElement(this.node, DROP_TARGET_CLASS);
    if (dropTarget) {
      dropTarget.classList.remove(DROP_TARGET_CLASS);
    }
  }

  /**
   * Handle the `'lm-dragover'` event for the widget.
   */
  private _evtDragOver(event: Drag.Event): void {
    event.preventDefault();
    event.stopPropagation();
    event.dropAction = event.proposedAction;
    const dropTarget = DOMUtils.findElement(this.node, DROP_TARGET_CLASS);
    if (dropTarget) {
      dropTarget.classList.remove(DROP_TARGET_CLASS);
    }
    const breadcrumbElements = this._getBreadcrumbElements();
    let index = -1;
    let target = event.target as HTMLElement;
    while (target && target !== this.node) {
      index = breadcrumbElements.indexOf(target);
      if (index !== -1) {
        break;
      }
      target = target.parentElement as HTMLElement;
    }
    if (index !== -1) {
      breadcrumbElements[index].classList.add(DROP_TARGET_CLASS);
    }
  }

  /**
   * Handle the `'lm-drop'` event for the widget.
   */
  private _evtDrop(event: Drag.Event): void {
    event.preventDefault();
    event.stopPropagation();
    if (event.proposedAction === 'none') {
      event.dropAction = 'none';
      return;
    }
    if (!event.mimeData.hasData(CONTENTS_MIME)) {
      return;
    }
    event.dropAction = event.proposedAction;

    let target = event.target as HTMLElement;
    while (target && target.parentElement) {
      if (target.classList.contains(DROP_TARGET_CLASS)) {
        target.classList.remove(DROP_TARGET_CLASS);
        break;
      }
      target = target.parentElement;
    }

    let destinationPath: string | null = null;
    if (target.classList.contains(BREADCRUMB_ROOT_CLASS)) {
      destinationPath = '/';
    } else if (target.classList.contains(BREADCRUMB_PREFERRED_CLASS)) {
      const preferredPath = PageConfig.getOption('preferredPath');
      destinationPath = preferredPath ? '/' + preferredPath : '/';
    } else if (target.dataset.path) {
      destinationPath = target.dataset.path;
    }

    if (!destinationPath) {
      return;
    }

    const model = this._model;
    const manager = model.manager;

    // Move all of the items.
    const promises: Promise<any>[] = [];
    const oldPaths = event.mimeData.getData(CONTENTS_MIME) as string[];
    for (const oldPath of oldPaths) {
      const name = PathExt.basename(oldPath);
      const newPath = PathExt.join(destinationPath, name);
      promises.push(renameFile(manager, oldPath, newPath));
    }
    void Promise.all(promises).catch(err => {
      return showErrorMessage(this._trans.__('Move Error'), err);
    });
  }

  /**
   * Get all breadcrumb elements that can be drop targets.
   */
  private _getBreadcrumbElements(): HTMLElement[] {
    const elements: HTMLElement[] = [];
    const children = this.node.children;
    for (let i = 0; i < children.length; i++) {
      const child = children[i] as HTMLElement;
      if (
        (child.classList.contains(BREADCRUMB_ITEM_CLASS) ||
          child.classList.contains(BREADCRUMB_ROOT_CLASS) ||
          child.classList.contains(BREADCRUMB_PREFERRED_CLASS)) &&
        !child.classList.contains(BREADCRUMB_ELLIPSIS_CLASS)
      ) {
        elements.push(child);
      }
    }
    return elements;
  }

  /**
   * Navigate to the given path.
   */
  private _commitNavigation(path: string): void {
    // Strip trailing slash (except bare root), then ensure a leading slash so
    // model.cd() → resolvePath() treats this as absolute rather than relative
    // to the current directory.
    let normalized =
      path.endsWith('/') && path !== '/' ? path.slice(0, -1) : path;
    if (!normalized.startsWith('/')) {
      normalized = '/' + normalized;
    }
    this._model
      .cd(normalized || '/')
      .catch(error => showErrorMessage(this._trans.__('Open Error'), error));
  }

  protected translator: ITranslator;
  private _trans: TranslationBundle;
  private _model: FileBrowserModel;
  private _hasPreferred: boolean;
  private _crumbs: ReadonlyArray<HTMLElement>;
  private _fullPath: boolean;
  private _previousState: Private.ICrumbsState | null = null;
  private _minimumLeftItems: number;
  private _minimumRightItems: number;
  private _pathNavigator: PathNavigator;
}

/**
 * The namespace for the `BreadCrumbs` class statics.
 */
export namespace BreadCrumbs {
  /**
   * An options object for initializing a bread crumb widget.
   */
  export interface IOptions {
    /**
     * A file browser model instance.
     */
    model: FileBrowserModel;

    /**
     * The application language translator.
     */
    translator?: ITranslator;

    /**
     * Show the full file browser path in breadcrumbs
     */
    fullPath?: boolean;

    /**
     * Number of items to show on left of ellipsis
     */
    minimumLeftItems?: number;

    /**
     * Number of items to show on right of ellipsis
     */
    minimumRightItems?: number;
  }
}

/**
 * The namespace for the crumbs private data.
 */
namespace Private {
  /**
   * Breadcrumb item list enum.
   */
  export enum Crumb {
    Home,
    Ellipsis,
    Preferred
  }

  /**
   * Breadcrumbs state.
   */
  export interface ICrumbsState {
    [key: string]: string | boolean | number;
    path: string;
    hasPreferred: boolean;
    fullPath: boolean;
    minimumLeftItems: number;
    minimumRightItems: number;
  }

  /**
   * Populate the breadcrumb node.
   */
  export function updateCrumbs(
    breadcrumbs: ReadonlyArray<HTMLElement>,
    state: ICrumbsState
  ): void {
    const node = breadcrumbs[0].parentNode as HTMLElement;

    // Remove all but the home or preferred node.
    const firstChild = node.firstChild as HTMLElement;
    while (firstChild && firstChild.nextSibling) {
      node.removeChild(firstChild.nextSibling);
    }

    if (state.hasPreferred) {
      node.appendChild(breadcrumbs[Crumb.Home]);
      node.appendChild(createCrumbSeparator());
    } else {
      node.appendChild(createCrumbSeparator());
    }

    const parts = state.path.split('/').filter(part => part !== '');
    if (!state.fullPath && parts.length > 0) {
      const minimumLeftItems = state.minimumLeftItems;
      const minimumRightItems = state.minimumRightItems;

      // Check if we need ellipsis
      if (parts.length > minimumLeftItems + minimumRightItems) {
        // Add left items
        for (let i = 0; i < minimumLeftItems; i++) {
          const elemPath = parts.slice(0, i + 1).join('/');
          const elem = createBreadcrumbElement(parts[i], elemPath);
          node.appendChild(elem);
          node.appendChild(createCrumbSeparator());
        }

        // Add ellipsis
        node.appendChild(breadcrumbs[Crumb.Ellipsis]);
        const hiddenStartIndex = minimumLeftItems;
        const hiddenEndIndex = parts.length - minimumRightItems;
        const hiddenParts = parts.slice(hiddenStartIndex, hiddenEndIndex);
        const hiddenFolders = hiddenParts.join('/');
        const hiddenPath =
          hiddenParts.length > 0
            ? parts.slice(0, hiddenEndIndex).join('/')
            : parts.slice(0, minimumLeftItems).join('/');
        breadcrumbs[Crumb.Ellipsis].title = hiddenFolders;
        breadcrumbs[Crumb.Ellipsis].dataset.path = hiddenPath;
        node.appendChild(createCrumbSeparator());

        // Add right items
        const rightStartIndex = parts.length - minimumRightItems;
        for (let i = rightStartIndex; i < parts.length; i++) {
          const elemPath = parts.slice(0, i + 1).join('/');
          const elem = createBreadcrumbElement(parts[i], elemPath);
          node.appendChild(elem);
          node.appendChild(createCrumbSeparator());
        }
      } else {
        for (let i = 0; i < parts.length; i++) {
          const elemPath = parts.slice(0, i + 1).join('/');
          const elem = createBreadcrumbElement(parts[i], elemPath);
          node.appendChild(elem);
          node.appendChild(createCrumbSeparator());
        }
      }
    } else if (state.fullPath && parts.length > 0) {
      for (let i = 0; i < parts.length; i++) {
        const elemPath = parts.slice(0, i + 1).join('/');
        const elem = createBreadcrumbElement(parts[i], elemPath);
        node.appendChild(elem);
        const separator = document.createElement('span');
        separator.textContent = '/';
        node.appendChild(separator);
      }
    }
  }

  /**
   * Create a breadcrumb element for a path part.
   */
  function createBreadcrumbElement(
    pathPart: string,
    fullPath: string
  ): HTMLElement {
    const elem = document.createElement('span');
    elem.className = BREADCRUMB_ITEM_CLASS;
    elem.textContent = pathPart;
    elem.title = fullPath;
    elem.dataset.path = fullPath;
    return elem;
  }

  /**
   * Create the breadcrumb nodes.
   */
  export function createCrumbs(): ReadonlyArray<HTMLElement> {
    const home = rootIcon.element({
      className: BREADCRUMB_ROOT_CLASS,
      tag: 'span',
      title: PageConfig.getOption('serverRoot') || 'Jupyter Server Root',
      stylesheet: 'breadCrumb'
    });
    home.dataset.path = '/';

    const ellipsis = ellipsesIcon.element({
      className: `${BREADCRUMB_ITEM_CLASS} ${BREADCRUMB_ELLIPSIS_CLASS}`,
      tag: 'span',
      stylesheet: 'breadCrumb'
    });

    const preferredPath = PageConfig.getOption('preferredPath');
    const path = preferredPath ? '/' + preferredPath : preferredPath;
    const preferred = preferredIcon.element({
      className: BREADCRUMB_PREFERRED_CLASS,
      tag: 'span',
      title: path || 'Jupyter Preferred Path',
      stylesheet: 'breadCrumb'
    });
    preferred.dataset.path = path || '/';

    return [home, ellipsis, preferred];
  }

  /**
   * Create the breadcrumb separator nodes.
   */
  export function createCrumbSeparator(): HTMLElement {
    const item = document.createElement('span');
    item.textContent = '/';
    return item;
  }
}
