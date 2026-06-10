/**
 * ARCHITECTURE
 *
 * PageTextExtractor        Reads visible text from the DOM
 *   .extractText()         via TreeWalker
 *       |
 *       v  raw text
 * SentenceParser           Splits raw text into sentences
 *   .parse()
 *       |
 *       v  sentences[]
 * VideoPlayer              Clears page, renders TV + canvas, animates text
 *   .setup()               _clearPage, _initCanvas, _initPlugins
 *   .setContent()          loads sentences
 *   .play()                fade-in -> hold -> fade-out per sentence
 *       |
 *       v  plugins via .addPlugin()
 * VideoDownloaderPlugin    Renders a "Download Video" button
 *   .init()
 *
 * ------------------------------------------------------------
 */

(function () {
    class PageTextExtractor {
        /**
         * Walks every element in the DOM via (TreeWalker).
         * Checks the element's computed styles and geometry to determine true visibility.
         * Collect every allowed text node in an array.
         * (further every text in the result array will be parsed to sentences)
         *
         * @param {Object} [options]
         * @param {number} [options.minLength=1] - Minimum character length for a text part to be included.
         *
         * @returns {string[]} Extracted page text parts.
         */
        extractText(options = {})
        {
            let optionsParsed = Object.assign({
                minLength: 1
            }, options)

            const SKIP_TAGS = new Set([
                'BUTTON', 'NAV', 'HEADER', 'FOOTER', 'ASIDE',      // structural & interactive
                'SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK',     // metadata & code
                'SVG', 'PATH', 'IMG', 'VIDEO', 'AUDIO', 'CANVAS',  // non‑textual media
                'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'LABEL',  // form elements
                'IFRAME', 'FRAME', 'OBJECT', 'EMBED'               // embedded content
            ])

            const SKIP_ROLES = new Set([
                'button', 'navigation', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox',
                'menuitemradio', 'toolbar', 'tablist', 'tab', 'scrollbar', 'slider',
                'spinbutton', 'switch', 'progressbar', 'meter', 'img', 'none',
                'presentation'
            ])

            const INLINE_TAGS = new Set([
                'A', 'ABBR', 'B', 'BDI', 'BDO', 'BR', 'CITE', 'CODE',
                'DATA', 'DFN', 'EM', 'I', 'KBD', 'MARK', 'Q', 'S',
                'SAMP', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP',
                'TIME', 'TT', 'U', 'VAR', 'WBR'
            ])

            const self = this

            /**
             * ============================================================================
             * EXAMPLE WALKTHROUGH
             * ============================================================================
             *
             * Consider the following HTML structure:
             *
             * <body>
             *   <!-- Skip tag -->
             *   <header>                              ← REJECT (branch cut)
             *     <p>Header text</p>                   (never visited)
             *   </header>
             *
             *   <!-- Hidden -->
             *   <div hidden>                           ← REJECT
             *     <p>Hidden text</p>                    (never visited)
             *   </div>
             *
             *   <!-- Skip role -->
             *   <div role="presentation">               ← REJECT
             *     <p>Presentation text</p>               (never visited)
             *   </div>
             *
             *   <!-- Container with block children -->
             *   <div class="outer">                     ← SKIP (has block children)
             *     <p>First paragraph</p>                 ← ACCEPT (block leaf)
             *     Direct text in outer                   ← ACCEPT (text node, parent has block children)
             *     <div class="inner">                     ← SKIP (has block children)
             *       <p>Nested paragraph</p>                 ← ACCEPT (block leaf)
             *       <span>Inline span in inner</span>       ← ACCEPT (inline leaf, parent has block children)
             *       More direct text in inner               ← ACCEPT (text node, parent has block children)
             *     </div>
             *   </div>
             *
             *   <!-- Block leaf with inline children -->
             *   <p>                                      ← ACCEPT (block leaf, no block children)
             *     This is                                 ← SKIP (text node inside accepted parent)
             *     <span>inline span inside p</span>       ← REJECT (inline leaf inside accepted parent)
             *     text                                    ← SKIP (text node inside accepted parent)
             *   </p>
             *
             *   <!-- Skip tag -->
             *   <script>console.log('skip');</script>    ← REJECT
             * </body>
             *
             * The walker processes nodes top‑down. The acceptNode function returns:
             *
             *   - REJECT for <header>, <div hidden>, <div role="presentation">, <script>,
             *     and the <span> inside the <p> (to avoid duplication).
             *   - SKIP for the two container <div>s (outer and inner).
             *   - ACCEPT for all other nodes shown above.
             *
             * The final set of extracted text parts (after trimming and length filtering) would be:
             *
             *   "First paragraph"
             *   "Direct text in outer"
             *   "Nested paragraph"
             *   "Inline span in inner"
             *   "More direct text in inner"
             *   "This is inline span inside p text"
             *
             * ============================================================================
             */

            // TreeWalker goes through every node top-down.
            // For each node, acceptNode() returns one of:
            //
            //   ACCEPT - we want this node's text
            //   SKIP   - ignore this node, but keep going into its children
            //   REJECT - ignore this node AND all its children (whole branch cut)
            //
            const walker = document.createTreeWalker(
                document.body,
                NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
                {
                    acceptNode(node) {
                        // ----- Text node -----
                        if (node.nodeType === Node.TEXT_NODE) {
                            return this._acceptTextNode(node);
                        }

                        // ----- Element node -----
                        return this._acceptElement(node);
                    },

                    /**
                     * Decide whether to accept a text node.
                     *
                     * "Block" = any element NOT in INLINE_TAGS (e.g., <div>, <p>, <li>, <section>, <h1>...).
                     * "Inline" = elements in INLINE_TAGS (e.g., <span>, <a>, <strong>, <em>, <b>...).
                     *
                     * A text node is accepted ONLY if its parent is a container element that has block children.
                     * Such a parent will be SKIPPED (not collected as a whole), so we must collect its direct text now.
                     * Otherwise, if the parent will be collected as a whole later, we SKIP the text node to avoid duplication.
                     *
                     * ─────────────────────────────────────────────────────────────────────────────
                     * EXAMPLE 1 - ACCEPT
                     *
                     * HTML:
                     *   <div>
                     *     Some text
                     *     <div>
                     *       <span>another text</span>
                     *     </div>
                     *   </div>
                     *
                     * TreeWalker order (simplified):
                     *   1. <div> (outer)                     → SKIP (has block child: inner <div>)
                     *   2.   text node "Some text "           → ??? we are here
                     *   3.   <div> (inner)                    → will be examined later
                     *
                     * Why does the text node "Some text " get ACCEPTED?
                     *   - Its parent is the outer <div>.
                     *   - The outer <div> has a block child (the inner <div>), so parentHasBlockChildren = true.
                     *   - Therefore the outer <div> is a container that will be SKIPPED (not collected).
                     *   - To avoid losing the text "Some text ", we must accept this text node now.
                     *
                     * Result: "Some text " is collected; the inner <div> will be handled separately.
                     *
                     * ─────────────────────────────────────────────────────────────────────────────
                     * EXAMPLE 2 - SKIP (text node inside an element that will be collected as a whole)
                     *
                     * HTML:
                     *   <p>
                     *       This is
                     *       <span>nested</span>
                     *       text
                     *   </p>
                     *
                     * TreeWalker:
                     *   1. <p>                               → ACCEPT (block leaf, no block children)
                     *   2.   text node "This is "             → ??? SKIP (because parent <p> will be collected)
                     *   3.   <span>nested</span>              → SKIP (inline leaf inside accepted parent)
                     *   4.   text node " text"                → SKIP
                     *
                     * Why are the text nodes skipped?
                     *   - Their parent is the <p>, which has NO block children (only inline <span> and text).
                     *   - The <p> itself will be ACCEPTED later as a block leaf.
                     *   - When we later read <p>.textContent, we get "This is nested text".
                     *   - If we also accepted the individual text nodes, we'd get duplicate text.
                     *
                     * ─────────────────────────────────────────────────────────────────────────────
                     * EXAMPLE 3 - Empty / whitespace text nodes are always SKIPPED.
                     */
                    _acceptTextNode(node) {
                        if ( ! node.textContent.trim())
                            return NodeFilter.FILTER_SKIP

                        const parent = node.parentElement

                        // Does the parent have any block children (elements not in INLINE_TAGS)?
                        // If yes, this parent is a container (like a <div> wrapping <p>s) and will be SKIPPED,
                        // so we must collect its direct text nodes now.
                        const parentHasBlockChild = Array.from(parent.children).some(
                            child => !INLINE_TAGS.has(child.tagName)
                        );

                        return parentHasBlockChild
                            ? NodeFilter.FILTER_ACCEPT
                            : NodeFilter.FILTER_SKIP;
                    },

                    /**
                     * Decide whether to accept an element.
                     * - Reject if it's hidden, has a skip‑tag, or a skip‑role.
                     * - Skip (go into children) if it has block children - it's a layout container.
                     * - Reject inline elements that would be collected by their parent.
                     * - Accept everything else (block elements with no block children).
                     *
                     * Examples:
                     *   REJECT: <script>, <style>, <div hidden>, <div role="presentation">
                     *   SKIP:   <div><p>...</p><p>...</p></div> (has block children, so we dive in)
                     *   REJECT: <span> inside a <p> (the <p> will be accepted, so the span is redundant)
                     *   ACCEPT: <p>Just text</p>, <li>Item</li>, <div>Only inline content</div>
                     */
                    _acceptElement(node) {
                        // Never collect these tags or roles - cut the whole branch
                        if (SKIP_TAGS.has(node.tagName)) return NodeFilter.FILTER_REJECT;

                        const role = node.getAttribute('role');
                        if (role && SKIP_ROLES.has(role)) return NodeFilter.FILTER_REJECT;

                        // Visually hidden - cut the branch
                        if (self._isElementHidden(node)) return NodeFilter.FILTER_REJECT;

                        // Does this element contain any block‑level children?
                        const hasBlockChild = Array.from(node.children).some(
                            child => !INLINE_TAGS.has(child.tagName)
                        );

                        // If it has block children, it's a container - we don't collect it,
                        // but we want to look inside it.
                        if (hasBlockChild) return NodeFilter.FILTER_SKIP;

                        // Now we know: this element has NO block children.
                        // It is a leaf in terms of block layout.

                        // Inline leaf: accept only if its parent is a container (has block children)

                        // ACCEPT: <span> - otherwise it would be lost
                        // <div>
                        //     <p>Some paragraph</p>
                        //     <span>Hello world</span>
                        // </div>
                        // REJECT: <strong> - because it would double - because <p> will be used as a whole
                        // <p>
                        //     This is <strong>bold</strong> text
                        // </p>
                        if (INLINE_TAGS.has(node.tagName)) {
                            // Does the parent of this inline element contain any block‑level children?
                            // If YES: the parent is a container that will be SKIPPED (like a <div> wrapping <p>s),
                            //         so we must collect this inline element now to capture its text.
                            // If NO: the parent itself will be collected later (as a block leaf or similar),
                            //        so we REJECT this inline element to avoid duplicating its text.
                            const parentHasBlockChild = Array.from(node.parentElement.children).some(
                                child => !INLINE_TAGS.has(child.tagName)
                            );
                            return parentHasBlockChild
                                ? NodeFilter.FILTER_ACCEPT
                                : NodeFilter.FILTER_REJECT;
                        }

                        // Block leaf (e.g. <p>, <li>, <div> with only inline children) - collect it
                        return NodeFilter.FILTER_ACCEPT;
                    }
                }
            )

            const textParts = []

            while (walker.nextNode()) {
                let textPart = walker.currentNode.textContent.trim()

                // filter invalid values
                if( textPart.length <= optionsParsed.minLength ) continue

                textParts.push(textPart)
            }

            return textParts
        }

        /**
         * We use it as a locale for the `Intl.Segmenter` during sentences extraction
         * @returns {string} Ex.: "en-US"
         */
        getPageLocale() {
            try {
                const candidates = [
                    document.documentElement.lang?.trim(),
                    document.querySelector('meta[http-equiv="Content-Language"]')?.getAttribute('content')?.trim(),
                    document.querySelector('meta[name="language"]')?.getAttribute('content')?.trim(),
                    navigator.languages?.[0],
                    navigator.language,
                    'en'
                ]

                for (const locale of candidates) {
                    if (!locale) continue

                    try {
                        // validate the locale
                        Intl.getCanonicalLocales(locale)

                        return locale
                    }
                    catch (e) {
                        console.error(`[SentenceParser] Invalid locale tag "${locale}":`, e)
                    }
                }

                return 'en'
            } catch (e) {
                console.error('[SentenceParser] _getPageLocale failed:', e)
                return 'en'
            }
        }

        /**
         * Returns true if this specific element is hidden.
         * No ancestor walk needed - the TreeWalker prunes parent elements first,
         * so children of hidden elements are never reached.
         *
         * Catches:
         *   - hidden attribute
         *   - display: none
         *   - visibility: hidden / collapse
         *   - opacity: 0
         *   - content-visibility: hidden
         *   - zero-dimension elements (width/height = 0)
         *   - off-screen positioning (negative left/top)
         *   - text-indent trick (large negative indent)
         *   - clip / clip-path screen-reader-only patterns
         *   - 1x1px overflow:hidden (.sr-only / .visually-hidden)
         *
         * @param {HTMLElement} el
         * @returns {boolean} true if the element is hidden
         */
        _isElementHidden(el) {
            if (el.hidden) return true

            const style = window.getComputedStyle(el)

            if (
                style.display === 'none' ||
                style.visibility === 'hidden' ||
                style.visibility === 'collapse'
            ) {
                return true
            }

            if (parseFloat(style.opacity) === 0) return true

            // Safety net for elements that are technically visible in CSS
            // but collapse to zero dimensions (e.g., empty containers with
            // no content or explicit size). Most hidden cases are already
            // caught by the style checks above, but this handles edge cases.
            const rect = el.getBoundingClientRect()
            if (rect.width === 0 && rect.height === 0) return true

            // Off-screen positioning
            if (
                style.position === 'absolute' &&
                (parseInt(style.left, 10) < -9000 || parseInt(style.top, 10) < -9000)
            ) {
                return true;
            }

            // Negative text-indent trick
            if (parseFloat(style.textIndent) < -999) return true

            // Screen-reader-only patterns: these techniques keep text accessible
            // to assistive technology while making it invisible to sighted users.
            // We want to skip this text since we're extracting visible content.

            // Legacy clip pattern - used by Bootstrap's .sr-only, WordPress, etc.
            // Example CSS:
            //   position: absolute;
            //   clip: rect(0, 0, 0, 0);
            if (
                style.position === 'absolute' &&
                style.clip === 'rect(0px, 0px, 0px, 0px)'
            ) {
                return true;
            }

            // Modern clip-path pattern - used by Tailwind's .sr-only, GitHub, etc.
            // Example CSS:
            //   clip-path: inset(50%);
            if (style.clipPath === 'inset(50%)') return true

            // Tiny-box pattern - used by Bootstrap 5's .visually-hidden, Foundation, etc.
            // Shrinks the element to 1x1px and clips overflow so nothing is visible.
            // Example CSS:
            //   width: 1px;
            //   height: 1px;
            //   overflow: hidden;
            if (
                parseInt(style.width, 10) <= 1 &&
                parseInt(style.height, 10) <= 1 &&
                style.overflow === 'hidden'
            ) {
                return true
            }

            // it is not hidden
            return false
        }
    }
    // --- end of class: PageTextExtractor --- //

    class SentenceParser {
        constructor() {
            this.sentences = []
        }

        /**
         * Parses raw text string into sentences string array.
         *
         * @param {string} rawText Some long text containing multiple sentences
         * @param {string} locale Ex. "en-US"
         *
         * @return {array} Sentences string[]
         */
        parse(rawText, locale) {
            this.clear()

            this.locale = locale
            this.rawText = rawText

            if ( ! this.rawText || ! this.rawText.trim())
                return []

            // Collapse all whitespace into single spaces before segmenting
            const normalizedText = this.rawText.replace(/\s+/g, ' ').trim()

            let sentences

            // Intl.Segmenter is supported from on Chrome v.121 or higher and Safari v.17 or higher
            if (typeof Intl !== 'undefined' && Intl.Segmenter) {
                sentences = this._segmentWithIntl(normalizedText, this.locale)
            } else {
                sentences = this._segmentWithRegex(normalizedText, this.locale)
            }

            this.sentences = sentences

            return this.sentences
        }

        clear() {
            this.sentences = []
        }

        /**
         * Use `Intl.Segmenter` to find all sentences.
         *
         * @param {string} text
         * @param {string} locale
         * @return {string[]}
         * @private
         */
        _segmentWithIntl(text, locale) {
            console.warn(`[SentenceParser] segmentWithIntl with locale: "${locale}"`)

            const segmenter = new Intl.Segmenter(locale, { granularity: 'sentence' })

            // console.warn(text, [...segmenter.segment(text)])

            return [...segmenter.segment(text)].map(s => s.segment.trim()).filter(Boolean)
        }

        /**
         * @param {string} text
         * @param {string} locale
         * @returns {string[]}
         * @private
         */
        _segmentWithRegex(text, locale) {
            console.warn('[SentenceParser] segmentWithRegex')

            // TODO as a backup strategy if Intl.Segmenter is not supported
            //   we may use Regex to match ?!. etc. and split into sentences but it would be less precise, due to
            //   words such as Mr. Mrs. etc.

            // This regex splits on punctuation marks . ! ? followed by a space or end of string.
            // const sentences = fullText.match(/[^.!?]+[.!?]+/g) || []

            console.error('Segment with regex is currently not implemented. Please use a browser with Intl.Segmenter support.')

            return []
        }
    }
    // --- end of class: SentenceParser --- //

    class VideoPlayer {
        static get EVENT_ON_PLAY_START() {
            return 'on_player_start'
        }

        static get EVENT_ON_PLAY_STOP() {
            return 'on_player_stop'
        }

        /**
         * @param {Object} [options]
         * @param {number}  [options.width=800]                                    - Canvas width in pixels.
         * @param {number}  [options.height=600]                                   - Canvas height in pixels.
         * @param {number}  [options.msPerChar=40]                                 - Milliseconds per character used to calculate display duration.
         * @param {number}  [options.minDisplayMs=1500]                            - Minimum time (ms) a sentence stays on screen.
         * @param {number}  [options.maxDisplayMs=20000]                           - Maximum time (ms) a sentence stays on screen.
         * @param {number}  [options.fadeMs=400]                                   - Duration (ms) of fade-in and fade-out transitions.
         * @param {number}  [options.fontSize=32]                                  - Font size in pixels.
         * @param {string}  [options.fontFamily='Georgia, "Times New Roman", serif'] - CSS font-family string.
         * @param {number}  [options.lineHeight=1.5]                               - Line height multiplier for wrapped text.
         * @param {number}  [options.maxLineWidth=0.75]                            - Maximum line width as a fraction of canvas width (0–1).
         * @param {string}  [options.bgColor='#ffffff']                            - Canvas background colour.
         * @param {string}  [options.textColor='#1a1a1a']                          - Text colour.
         */
        constructor(options = {}) {

            this.events = []
            this.plugins = []
            this.canvas = undefined
            this.ctx = undefined
            this.sentences = []

            this.width = options.width ?? 800
            this.height = options.height ?? 600

            this.config = {
                msPerChar: options.msPerChar || 40,
                minDisplayMs: options.minDisplayMs || 1500,
                maxDisplayMs: options.maxDisplayMs || 20000,
                fadeMs: options.fadeMs || 400,
                fontSize: options.fontSize || 32,
                fontFamily: options.fontFamily || 'Georgia, "Times New Roman", serif',
                lineHeight: options.lineHeight || 1.5,
                maxLineWidth: options.maxLineWidth || 0.75,
                bgColor: options.bgColor || '#ffffff',
                textColor: options.textColor || '#1a1a1a'
            }
        }

        /**
         * @param {string} eventName
         * @param {Function} callback
         */
        addEventListener(eventName, callback) {
            if( this.events[eventName] === undefined ) {
                this.events[eventName] = []
            }
            this.events[eventName].push(callback)
        }

        /** @param {string} eventName */
        triggerEvent(eventName) {
            if( ! (eventName in this.events) ) {
                return
            }

            for (let callback of this.events[eventName]) {
                callback()
            }
        }

        setup() {
            this._clearPage()
            this._initCanvas()
            this._initPlugins()
        }

        /** @param {VideoDownloaderPlugin} plugin */
        addPlugin(plugin) {
            this.plugins.push(plugin)
        }

        /**
         * @param {string[]} sentences
         * @returns {false|void} false if invalid input
         */
        setContent(sentences) {
            if( ! Array.isArray(sentences) ) {
                alert('[Video Player] Invalid non-array sentences given.')
                return false
            }

            this.sentences = sentences
        }

        /**
         * Splits sentences that are too tall for the canvas into smaller chunks.
         * Each chunk contains only as many wrapped lines as fit within the canvas height
         * (with vertical padding). Must be called after _initCanvas so ctx is available.
         *
         * 1. Calculates maxLines - how many wrapped lines fit vertically, based on
         *    canvas height, font size, and line height (with padding).
         * 2. For each sentence, wraps it into lines using the existing _wrapText
         *    (same logic _drawFrame uses).
         * 3. If the lines fit - keeps the sentence as-is.
         * 4. If they overflow - splits into chunks of maxLines lines each, shown as
         *    separate "sentences" with their own fade in/out cycle.
         * 5. It runs at the start of play() so the canvas context is available for
         *    text measurement.
         */
        _splitOversizedSentences() {
            const ctx = this.ctx
            const maxWidth = this.width * this.config.maxLineWidth
            const lineHeightPx = this.config.fontSize * this.config.lineHeight
            const verticalPadding = this.config.fontSize * 2

            // How many wrapped lines fit vertically in the canvas.
            // Formula: usable height / line height, rounded down, at least 1.
            //
            // Example with default values (height=600, fontSize=32, lineHeight=1.5):
            //   verticalPadding = 32 * 2 = 64
            //   lineHeightPx   = 32 * 1.5 = 48
            //   maxLines        = floor((600 - 64) / 48) = floor(11.16) = 11
            //
            // Example with a smaller canvas (height=300, fontSize=32, lineHeight=1.5):
            //   maxLines        = floor((300 - 64) / 48) = floor(4.91) = 4
            const maxLines = Math.max(1, Math.floor((this.height - verticalPadding) / lineHeightPx))

            // We need to set ctx.font before calling _wrapText because _wrapText uses ctx.measureText() to calculate line breaks.
            // The canvas context doesn't retain the font between draw calls - _drawFrame sets it each time it runs,
            // but _splitOversizedSentences runs independently before any frame is drawn, so the font would otherwise
            // be whatever the default is (10px sans-serif), giving incorrect width measurements and wrong splits
            ctx.font = this.config.fontSize + 'px ' + this.config.fontFamily

            const result = []

            for (const sentence of this.sentences) {
                const lines = this._wrapText(ctx, sentence, maxWidth)

                if (lines.length <= maxLines) {
                    result.push(sentence)
                    continue
                }

                // Split lines into chunks that fit the canvas
                for (let i = 0; i < lines.length; i += maxLines) {
                    result.push(lines.slice(i, i + maxLines).join(' '))
                }
            }

            this.sentences = result
        }

        async play() {
            this._splitOversizedSentences()

            this.triggerEvent(VideoPlayer.EVENT_ON_PLAY_START)

            // Initial blank pause
            this._drawFrame('', 0)

            await new Promise(function (r) {
                setTimeout(r, 500)
            })

            for (let i = 0; i < this.sentences.length; i++) {
                const sentence = this.sentences[i]
                const displayTime = this._calcDuration(sentence)

                // Fade in
                await this._fade(sentence, 0, 1, this.config.fadeMs)
                // Hold for reading
                await this._hold(sentence, displayTime)
                // Fade out
                await this._fade(sentence, 1, 0, this.config.fadeMs)

                // Brief pause between sentences
                this._drawFrame('', 0)
                await new Promise(function (r) { setTimeout(r, 200); })
            }

            // Show completion message
            await this._fade('— End —', 0, 1, this.config.fadeMs * 2)

            this.triggerEvent(VideoPlayer.EVENT_ON_PLAY_STOP)
        }

        // ---------------------------------- //

        _clearPage() {
            // This is not enough, because script tags in the header exists
            // and may include iframes etc. messing with our logic.
            // document.body.innerHTML = ''

            // This fails with:
            //   This document requires 'TrustedHTML' assignment. The action has been blocked.
            //   Failed to execute 'write' on 'Document': This document requires 'TrustedHTML' assignment.
            // document.open()
            // document.write('<!DOCTYPE html><html><head></head><body></body></html>')
            // document.close()

            // // Remove everything from <html> and rebuild clean head + body.
            // // This avoids document.write() which is blocked by Trusted Types CSP.
            // const html = document.documentElement
            // while (html.firstChild) {
            //     html.removeChild(html.firstChild)
            // }
            // html.appendChild(document.createElement('head'))
            // html.appendChild(document.createElement('body'))

            // This seems to be the better way of doing it.
            // It also prevents issues such as:
            //     "This document requires 'TrustedHTML' assignment. The action has been blocked."
            document.head.replaceChildren()

            // we use new body - to prevent inline css, attributes etc.
            const newBody = document.createElement("body")
            document.documentElement.replaceChild(newBody, document.body)

            // Reset inline styles just to be sure
            document.documentElement.style = ""
            document.body.style = ""

            // Clear head and body content
            document.head.replaceChildren()

            // set the utf 8 charset to not mess the encodings
            const metaCharset = document.createElement("meta")
            metaCharset.setAttribute("charset", "utf-8")
            document.head.appendChild(metaCharset)

            document.title = 'Video Text Reader'
        }

        _initCanvas() {
            // White page with centered TV
            Object.assign(document.body.style, {
                margin: '0',
                padding: '0',
                display: 'flex',
                alignItems: 'center',
                minHeight: '100vh',
                backgroundColor: '#ffffff'
            })

            // TV frame
            const tv = document.createElement('div')
            Object.assign(tv.style, {
                position: 'relative',
                padding: '24px 24px 40px',
                backgroundColor: '#1a1a1a',
                borderRadius: '12px',
                boxShadow: '0 8px 40px rgba(0, 0, 0, 0.3)'
            })

            // Screen (scaled for HiDPI / Retina displays)
            const dpr = window.devicePixelRatio || 1
            const canvas = document.createElement('canvas')
            canvas.width = this.width * dpr
            canvas.height = this.height * dpr
            Object.assign(canvas.style, {
                display: 'block',
                width: this.width + 'px',
                height: this.height + 'px',
                backgroundColor: '#ffffff',
                borderRadius: '4px'
            })

            // Power LED
            const led = document.createElement('div')
            Object.assign(led.style, {
                width: '6px',
                height: '6px',
                backgroundColor: '#00cc66',
                borderRadius: '50%',
                position: 'absolute',
                bottom: '16px',
                right: '24px',
                boxShadow: '0 0 4px #00cc66'
            })

            // Stand neck
            const neck = document.createElement('div')
            Object.assign(neck.style, {
                width: '40px',
                height: '30px',
                backgroundColor: '#1a1a1a',
                margin: '0 auto'
            })

            // Stand base
            const base = document.createElement('div')
            Object.assign(base.style, {
                width: '160px',
                height: '8px',
                backgroundColor: '#1a1a1a',
                borderRadius: '4px',
                margin: '0 auto'
            })

            // Assemble
            tv.appendChild(canvas)
            tv.appendChild(led)

            const wrapper = document.createElement('div')
            wrapper.style.margin = '0 auto'
            wrapper.appendChild(tv)
            wrapper.appendChild(neck)
            wrapper.appendChild(base)

            document.body.appendChild(wrapper)
            this.canvas = canvas

            const ctx = canvas.getContext('2d')
            ctx.scale(dpr, dpr)
            this.ctx = ctx
        }

        _initPlugins() {
            for( let plugin of this.plugins ) {
                plugin.init()
            }
        }

        /**
         * Holds the current sentence on screen for the given duration.
         * Returns a promise that resolves after the hold period.
         *
         * @param {string} sentence
         * @param {number} durationMs
         * @returns {Promise<void>}
         */
        _hold(sentence, durationMs) {
            const self = this

            return new Promise(function (resolve) {
                self._drawFrame(sentence, 1)
                setTimeout(resolve, durationMs)
            })
        }

        /**
         * Reading time based on character count, clamped to min/max bounds.
         *
         * Character-based timing is more accurate than word-based because
         * it accounts for word length differences:
         *   "Hi there"         →  8 chars →  400ms + 1500 base = 1900ms → clamped to 1500ms
         *   "Hello world"      → 11 chars →  550ms + 1500 base = 2050ms
         *   "Internationalization considerations apply" → 42 chars → 2100ms + 1500 base = 3600ms
         *   A full screen chunk (~500 chars) → 25000ms + 1500 base → clamped to 20000ms
         *
         * @param {string} sentence
         * @returns {number} display duration in ms
         */
        _calcDuration(sentence) {
            const charCount = sentence.length
            const duration = this.config.minDisplayMs + (charCount * this.config.msPerChar)
            return Math.min(this.config.maxDisplayMs, duration)
        }

        /**
         * Draws a single frame: clears the canvas, draws the sentence centered
         * with the given opacity (for fade effects).
         *
         * @param {string} sentence
         * @param {number} opacity 0-1
         */
        _drawFrame(sentence, opacity) {
            const ctx = this.ctx

            // Clear canvas
            ctx.fillStyle = this.config.bgColor
            ctx.fillRect(0, 0, this.width, this.height)

            // Set text style
            ctx.fillStyle = this.config.textColor
            ctx.globalAlpha = opacity
            ctx.font = this.config.fontSize + 'px ' + this.config.fontFamily
            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'

            // Word-wrap the sentence
            const maxWidth = this.width * this.config.maxLineWidth
            const lines = this._wrapText(ctx, sentence, maxWidth)
            const lineHeightPx = this.config.fontSize * this.config.lineHeight
            const totalHeight = lines.length * lineHeightPx
            const startY = (this.height - totalHeight) / 2 + lineHeightPx / 2

            // Draw each line
            for (let i = 0; i < lines.length; i++)
            {
                ctx.fillText(lines[i], this.width / 2, startY + i * lineHeightPx)
            }

            ctx.globalAlpha = 1
        }

        /**
         * Animates a fade: from startOpacity to endOpacity over durationMs.
         *
         * Frame-rate independent - uses elapsed real time (performance.now),
         * not frame count, so the duration is consistent on 60Hz, 120Hz, etc.
         *
         * @param {string} sentence
         * @param {number} startOpacity 0-1
         * @param {number} endOpacity 0-1
         * @param {number} durationMs
         * @returns {Promise<void>}
         */
        async _fade(sentence, startOpacity, endOpacity, durationMs) {
            const self = this

            return new Promise(function (resolve) {
                const startTime = performance.now()

                // requestAnimationFrame(step) schedules `step` to run on the next
                // screen repaint (~16.6ms at 60Hz, ~8.3ms at 120Hz).
                //
                // The browser passes a high-resolution timestamp (`now`) to `step`,
                // which we use to compute elapsed time. This makes the animation
                // frame-rate independent - the fade always lasts exactly `durationMs`
                // regardless of the monitor's refresh rate.
                //
                // Timeline example (fade-in, durationMs = 400, 60Hz monitor):
                //
                //   Frame 0  →  now ≈ startTime        →  elapsed ≈ 0ms    → progress ≈ 0.00
                //   Frame 1  →  now ≈ startTime + 16ms →  elapsed ≈ 16ms   → progress ≈ 0.04
                //   Frame 2  →  now ≈ startTime + 33ms →  elapsed ≈ 33ms   → progress ≈ 0.08
                //   ...
                //   Frame 24 →  now ≈ startTime + 400ms → elapsed ≈ 400ms  → progress = 1.00 (clamped)
                //
                // On a 120Hz monitor the same 400ms fade would run ~48 frames instead
                // of ~24, but the visual result is identical - just smoother.

                function step(now) {
                    const elapsed = now - startTime

                    // Linear progress: how far through the animation we are (0 → 1).
                    // Clamped to 1 so we never overshoot if a frame arrives late.
                    //
                    //   elapsed = 0ms    → progress = 0.00  (start)
                    //   elapsed = 100ms  → progress = 0.25
                    //   elapsed = 200ms  → progress = 0.50  (halfway)
                    //   elapsed = 400ms  → progress = 1.00  (done)
                    //   elapsed = 450ms  → progress = 1.00  (clamped, frame arrived late)
                    const progress = Math.min(elapsed / durationMs, 1)

                    // Quadratic ease-in-out curve.
                    //
                    // Converts linear progress into a smooth acceleration/deceleration:
                    //   - First half  (progress 0 → 0.5):  ease IN  - starts slow, speeds up
                    //     Formula: 2 * p * p
                    //   - Second half (progress 0.5 → 1):  ease OUT - slows down, settles gently
                    //     Formula: 1 - (-2p + 2)² / 2
                    //
                    // Example values:
                    //
                    //   progress  │  eased   │  visual effect
                    //   ──────────┼──────────┼─────────────────────────
                    //   0.00      │  0.000   │  fully transparent (start)
                    //   0.10      │  0.020   │  barely visible - slow start
                    //   0.25      │  0.125   │  still faint
                    //   0.50      │  0.500   │  halfway - fastest change
                    //   0.75      │  0.875   │  nearly opaque
                    //   0.90      │  0.980   │  almost done - slow finish
                    //   1.00      │  1.000   │  fully opaque (end)
                    //
                    // Compared to linear (progress === eased), this avoids the abrupt
                    // "switch on/off" feeling and produces a natural, cinematic fade.
                    const eased = progress < 0.5
                        ? 2 * progress * progress
                        : 1 - Math.pow(-2 * progress + 2, 2) / 2

                    // Interpolate between startOpacity and endOpacity using the eased value.
                    //
                    // Generic formula: result = start + (end - start) * t
                    //
                    // Fade-in example  (startOpacity=0, endOpacity=1):
                    //   eased = 0.00 → opacity = 0 + (1-0) * 0.00 = 0.00
                    //   eased = 0.50 → opacity = 0 + (1-0) * 0.50 = 0.50
                    //   eased = 1.00 → opacity = 0 + (1-0) * 1.00 = 1.00
                    //
                    // Fade-out example (startOpacity=1, endOpacity=0):
                    //   eased = 0.00 → opacity = 1 + (0-1) * 0.00 = 1.00
                    //   eased = 0.50 → opacity = 1 + (0-1) * 0.50 = 0.50
                    //   eased = 1.00 → opacity = 1 + (0-1) * 1.00 = 0.00
                    const opacity = startOpacity + (endOpacity - startOpacity) * eased
                    self._drawFrame(sentence, opacity)

                    if (progress < 1) {
                        // Not done yet - schedule the next frame
                        requestAnimationFrame(step)
                    } else {
                        // Animation complete - resolve the Promise so play() can continue
                        resolve()
                    }
                }

                // Kick off the first frame
                requestAnimationFrame(step)
            })
        }

        /**
         * Word-wraps text to fit within maxWidth on the canvas.
         *
         * @param {CanvasRenderingContext2D} ctx
         * @param {string} text
         * @param {number} maxWidth in px
         * @returns {string[]} wrapped lines
         */
        _wrapText(ctx, text, maxWidth) {
            const words = text.split(/\s+/)
            const lines = []
            let currentLine = ''

            for (const word of words) {
                // Build a candidate line by appending the next word.
                // If currentLine is empty (first word on a new line), testLine is just the word itself.
                const testLine = currentLine ? currentLine + ' ' + word : word

                // Measure the candidate line's pixel width using the canvas font metrics.
                // If it exceeds maxWidth, the word doesn't fit - break here.
                //
                // The `&& currentLine` guard handles the edge case where a single word
                // is wider than maxWidth. Without it, that word would be pushed to a new line,
                // measured again, still too wide, pushed again - infinite loop.
                // With the guard, we accept the oversized word as-is (it will overflow
                // slightly) and continue with the next word on a fresh line.
                //
                // ─────────────────────────────────────────────────────────────────
                // EXAMPLE - text: "The quick brown fox jumps", maxWidth: 200px
                //
                // Assume these measured widths (px):
                //   "The"                    →  40px
                //   "The quick"              → 110px
                //   "The quick brown"        → 185px
                //   "The quick brown fox"    → 230px  ← exceeds 200px!
                //
                // Iteration 1 - word="The"
                //   currentLine = ""  →  testLine = "The"  (40px ≤ 200) → accept
                //   currentLine = "The"
                //
                // Iteration 2 - word="quick"
                //   currentLine = "The"  →  testLine = "The quick"  (110px ≤ 200) → accept
                //   currentLine = "The quick"
                //
                // Iteration 3 - word="brown"
                //   currentLine = "The quick"  →  testLine = "The quick brown"  (185px ≤ 200) → accept
                //   currentLine = "The quick brown"
                //
                // Iteration 4 - word="fox"
                //   currentLine = "The quick brown"  →  testLine = "The quick brown fox"  (230px > 200) → BREAK
                //   lines.push("The quick brown")   ← finalize current line
                //   currentLine = "fox"              ← start new line with "fox"
                //
                // Iteration 5 - word="jumps"
                //   currentLine = "fox"  →  testLine = "fox jumps"  (120px ≤ 200) → accept
                //   currentLine = "fox jumps"
                //
                // After loop: lines.push("fox jumps")
                //
                // Result: ["The quick brown", "fox jumps"]
                // ─────────────────────────────────────────────────────────────────
                if (ctx.measureText(testLine).width > maxWidth && currentLine) {
                    lines.push(currentLine)
                    currentLine = word
                } else {
                    currentLine = testLine
                }
            }

            if (currentLine) lines.push(currentLine)

            return lines
        }
    }
    // --- end of class: VideoPlayer --- //

    class VideoDownloaderPlugin {
        /**
         * @param {VideoPlayer} player
         * @param {Object} [options]
         * @param {number} [options.videoBitrate=2500000]
         */
        constructor(player, options = {}) {

            this.options = Object.assign({
                videoBitrate: 2500000  // Bitrate for recorded video output (bps)
            }, options)

            this.player = player
        }

        init() {
            this._initVideoRecorder()

            this.player.addEventListener(VideoPlayer.EVENT_ON_PLAY_START, () => {
                this._startRecording()
            })

            this.player.addEventListener(VideoPlayer.EVENT_ON_PLAY_STOP, () => {
                this._stopRecording()
            })
        }

        _initVideoRecorder() {
            this.chunks = []
            const stream = this.player.canvas.captureStream(30) // 30 fps

            const candidates = [
                'video/webm;codecs=vp9',
                'video/webm',
                'video/mp4',
            ]

            // Use the first MIME type the browser supports
            this.mimeType = candidates.find(type => MediaRecorder.isTypeSupported(type))

            if ( ! this.mimeType) {
                console.error('[VideoDownloaderPlugin] No supported video MIME type found.')
                return
            }

            this.recorder = new MediaRecorder(stream, {
                mimeType: this.mimeType,
                videoBitsPerSecond: this.options.videoBitrate,
            })

            this.recorder.ondataavailable = (e) => {
                if (e.data.size > 0) this.chunks.push(e.data)
            }

            this.recorder.onstop = () => this._createDownloadButton()
        }

        _startRecording() {
            if ( ! this.recorder)
                return

            this.recorder.start()
            console.log('Recording started...')
        }

        // Stop recording triggers download button creation.
        _stopRecording() {
            if ( ! this.recorder)
                return

            if (this.recorder.state === 'recording') {
                this.recorder.stop()
                console.log('Recording stopped.')
            }
        }

        _buildVideoBlob() {
            const blob = new Blob(this.chunks, { type: this.mimeType })
            const url = URL.createObjectURL(blob)
            const ext = this.mimeType.includes('webm') ? 'webm' : 'mp4'

            return { blob, url, ext }
        }

        _createDownloadButton() {

            const { url, ext } = this._buildVideoBlob()

            // 1. Create the Container
            const container = document.createElement('div')

            container.style.position = 'fixed'
            container.style.zIndex = '9999'
            container.style.top = '10px'
            container.style.right = '10px'

            // 2. Create the Link (Button)
            const downloadBtn = document.createElement('a')
            downloadBtn.href = url
            downloadBtn.title = 'Download Video'
            downloadBtn.download = 'text-movie.' + ext

            const label = document.createTextNode('Download Video ')
            const icon = document.createTextNode('\u2B07')
            downloadBtn.appendChild(label)
            downloadBtn.appendChild(icon)

            // 3. Apply CSS Rules via JS
            const btnStyle = {
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '6px',
                padding: '8px 16px',
                backgroundColor: '#007bff',
                color: '#ffffff',
                borderRadius: '6px',
                textDecoration: 'none',
                fontSize: '14px',
                boxShadow: '0 2px 5px rgba(0,0,0,0.2)',
                transition: 'background-color 0.3s ease',
                cursor: 'pointer'
            }

            // Assign styles to the button
            Object.assign(downloadBtn.style, btnStyle)

            // Hover effects via JS listeners
            downloadBtn.onmouseenter = () => downloadBtn.style.backgroundColor = '#0056b3'
            downloadBtn.onmouseleave = () => downloadBtn.style.backgroundColor = '#007bff'

            container.appendChild(downloadBtn)

            // display the button
            document.body.append(container)
        }
    }
    // --- end of class: VideoDownloaderPlugin --- //

    // ----------------------------------------------------------------------- //
    // ----------------------------------------------------------------------- //
    // ----------------------------------------------------------------------- //

    window.runPageReader = function()
    {
        const textExtractor = new PageTextExtractor()

        // we collect every visible and allowed text node
        let textParts = textExtractor.extractText({
            minLength: 1 // filters how much length we accept for a valid text
        })

        // we extract the page locale in order to use it in `Intl.Segmenter` via `SentenceParser`
        let pageLocale = textExtractor.getPageLocale()

        const sentenceParser = new SentenceParser()

        // Split each text part into individual sentences (one text node may contain many)
        let sentences = []
        for ( let rawTextPart of textParts ) {
            const parsedSentences = sentenceParser.parse(rawTextPart, pageLocale)
            sentences = [...sentences, ...parsedSentences]
        }

        console.warn('page-reader [DEBUG]', {pageLocale, textParts, sentences})

        let player = new VideoPlayer({
            width: 800,                                             // Canvas width in pixels
            height: 600,                                            // Canvas height in pixels
            // msPerChar: 40,                                       // Milliseconds per character for display duration
            // minDisplayMs: 1500,                                  // Minimum time a sentence stays on screen (ms)
            // maxDisplayMs: 20000,                                 // Maximum time a sentence stays on screen (ms)
            // fadeMs: 400,                                         // Duration of fade-in / fade-out transitions (ms)
            // fontSize: 32,                                        // Text size in pixels drawn on the canvas
            // fontFamily: 'Georgia, "Times New Roman", serif',     // Font stack for rendered text
            // lineHeight: 1.5,                                     // Line spacing multiplier for wrapped text
            // maxLineWidth: 0.75,                                  // Max text width as fraction of canvas width (0-1)
            // bgColor: '#ffffff',                                  // Canvas background color
            // textColor: '#1a1a1a'                                 // Text color drawn on the canvas
        })

        player.addPlugin(
            new VideoDownloaderPlugin(player, {
                // videoBitrate: 2500000,                           // Bitrate for recorded video output (bps)
            })
        )

        player.setup()
        player.setContent(sentences)
        player.play()
    }

    // auto-run on script load
    runPageReader()
})()
