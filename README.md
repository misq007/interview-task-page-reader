
# Interview Task

```
Instructions:

Develop a vanilla JavaScript script that captures the visible text content of a webpage and then replaces the entire webpage content with a white canvas displaying the captured text sentence by sentence like a movie by paying attention to the time needed for every sentence to be read properly from the observer (long sentences are displayed for a longer period than short sentences).

Requirements:
1. CaptureVisibleTextContent
○ The script should extract only the visible text content from the webpage.
○ Ensure that text from hidden elements or not textual elements are excluded. 2. ReplacePageContent
○ Replace the entire content of the page with a blank white page containing a centered canvas element. The feeling of the user should be like he is watching a movie with the content.

3. AnimateTextonCanvas
○ Display the captured text on the canvas, split by sentences.
○ Each sentence should be displayed for a long enough period to be read and the time
should be adequate according to its length.
○ Ensure smooth transitions and clear readability.

Bonus assignment:
Allow the download of the result as a video.
Deliverables:
● A single JavaScript file containing all the required functionality.
● The code should be well-commented and organized for readability and maintainability.
● The code should be able to be executed directly in the browser console of the browser on
any page.
● The code should work on Chrome v.121 or higher and Safari v.17 or higher.
```

---

## Implementation

---

### Text Extraction

I've used AI for discussing the right way of extracting the text.
My initial thoughts were to somehow achieve it by:

- recursive dom checks using `document.children`
- mass global search for elements using `document.querySelector` or similar.
- getting the `document.body.innerText` but we cannot filter the buttons, navigations etc.
- to see how browser based PDF exporters are working
- utilizing the print preview somehow
- doing page screenshot and using image recognition :)

After careful re-search I found that using `TreeWalker` is the most professional way of doing it.

I extracted the text nodes from elements but in a smarter way, because this `<p>This is a <b>sentence</b></p>` should 
output "This is a sentence" instead of two separate "This is a" and "sentence".

### Sentences Parsing

We need it, because in one `<p>` can have multiple sentences. 
I was going to manually match and parse them with regex but found that it is already done by a much smarter component `Intl.Segmenter`.
The regex variant can be implemented as a backup variant if `Intl.Segmenter` is not supported.

> I also extract the page locale in order to give it to the `Intl.Segmenter` so to parse the text in the proper way.

### Canvas and Video

I used AI to generate `Context2D` boilerplate.

I manually did go over the code and checked everything - line by line making sure I understand everything 
and changed it to be the way I wanted it to be.
Also I did go and check the actual documentation for some of the stuff.

I have added the following features:

    - ability to write plugins (VideoDownloadPlugin)
    - simple event system that can be used from the plugins
    - if sentences are too big for the canvas - split them and show them as separate onces

### Browser Support

For the browser support on Chrome v.121 or higher and Safari v.17 or higher:

- I've checked most of the syntax features like (arrow functions, Promises etc.) - manually using https://caniuse.com/. 
- Also used AI to do a final check of my entire code if it is supported.
- Finally tested it on: https://www.browserstack.com/
