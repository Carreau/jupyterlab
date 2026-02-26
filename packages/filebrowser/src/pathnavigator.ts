// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { addIcon } from '@jupyterlab/ui-components';

const PATHNAVIGATOR_ADDER_CLASS = 'jp-PathNavigator-adder';
const PATHNAVIGATOR_INPUT_CLASS = 'jp-PathNavigator-input';
const PATHNAVIGATOR_SUGGESTIONS_CLASS = 'jp-PathNavigator-suggestions';
const PATHNAVIGATOR_SUGGESTION_CLASS = 'jp-PathNavigator-suggestion';

/**
 * A component that renders a path input with directory autocomplete for quick
 * navigation. It owns an adder button (the trigger), a text input, and a
 * suggestions dropdown.
 *
 * Interaction is communicated outward via callbacks rather than direct
 * coupling to the parent widget.
 */
export class PathNavigator {
  constructor(options: PathNavigator.IOptions) {
    this._options = options;

    this._adderNode = addIcon.element({
      className: PATHNAVIGATOR_ADDER_CLASS,
      tag: 'span',
      title: 'Go to path…',
      stylesheet: 'breadCrumb'
    });

    this._inputNode = document.createElement('input');
    this._inputNode.type = 'text';
    this._inputNode.className = PATHNAVIGATOR_INPUT_CLASS;
    this._inputNode.placeholder = 'Type a path…';

    this._suggestionsNode = document.createElement('ul');
    this._suggestionsNode.className = PATHNAVIGATOR_SUGGESTIONS_CLASS;
    this._suggestionsNode.style.display = 'none';

    this._node = document.createElement('span');
    this._node.className = 'jp-PathNavigator';
    this._node.appendChild(this._adderNode);
    this._node.appendChild(this._inputNode);
    this._node.appendChild(this._suggestionsNode);
  }

  /**
   * The root node containing the adder button, input, and suggestions dropdown.
   * Append this single node to the DOM.
   */
  get node(): HTMLElement {
    return this._node;
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
      li.className = PATHNAVIGATOR_SUGGESTION_CLASS;
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
      if (target.classList.contains(PATHNAVIGATOR_SUGGESTION_CLASS)) {
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
  private _node: HTMLElement;
  private _adderNode: HTMLElement;
  private _inputNode: HTMLInputElement;
  private _suggestionsNode: HTMLElement;
  private _isActive = false;
  private _suggestions: string[] = [];
  private _currentFilteredSuggestions: string[] = [];
  private _activeSuggestionIndex = -1;
  private _suggestionDirPath = '';
}

export namespace PathNavigator {
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
