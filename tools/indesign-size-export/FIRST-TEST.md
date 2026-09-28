# First test: Size-Sorted Export

**Time:** about 15 minutes. **You need:** a computer with InDesign, and the file `SizeSortedExport.jsx`.
**Safe:** it only reads a copy of a document and writes new files into a test folder. Nothing else on the computer changes.

---

## 1. Get the script

1. In the Claude chat, click the **SizeSortedExport.jsx** file card and download it.
2. It goes to your **Downloads** folder.

## 2. Make a test folder

1. On the Desktop, right-click → **New** → **Folder**. Name it `Size Test`.
2. Copy **one** InDesign file into it, one that has pages of different sizes. Use a **copy**, not the client's original.

   No such file? In InDesign, make a new document with 3 pages. Click the **Page Tool** (Shift+P), click page 2, and type a new width and height in the bar at the top, e.g. 1080 × 1080 px. Save it into `Size Test`.

## 3. Put the script into InDesign

1. Open InDesign.
2. Menu **Window** → **Utilities** → **Scripts**. The Scripts panel opens.
3. In that panel, right-click **User** → **Reveal in Explorer**. A folder opens.
4. Drag **SizeSortedExport.jsx** from **Downloads** into that folder.
5. Back in InDesign, open **User** in the Scripts panel. The script is now listed.

## 4. Run the test

1. In the Scripts panel, **double-click SizeSortedExport.jsx**. The dashboard window opens.
2. **Folders** → click **Choose...** → pick `Desktop\Size Test` → **OK**.
3. **Documents** → select **Every InDesign file in the root folder**. Leave **Watch** unticked.
4. **Formats** → tick **PDF**, **JPEG** and **PNG**. Leave the preset as **[High Quality Print]** and the resolution at **72**.
5. Click **Execute Batch Export**.
6. Wait until the Status line says **Finished**.

## 5. Check the result

Click **Open export folder** on the dashboard.

| Check | Good result |
|---|---|
| Folders | One folder per page size, e.g. `A4`, `1080x1080` |
| Files | Each page is in the folder matching its size, as a .pdf, .jpg and .png |
| Image size | A 1080 × 1080 page gives a 1080 × 1080 image (right-click the image → **Properties** → **Details**) |
| PDF | Each PDF has **one** page |
| Your file | The original InDesign file is unchanged |

## 6. Send me the result

Send three things in the Claude chat:
1. A screenshot of the dashboard (press **Windows + Shift + S**, drag over the window, then paste into the chat).
2. A screenshot of the export folder.
3. Anything that looked wrong. Copy any line with a red **X** or orange **!** word for word.

---

**If something goes wrong**
- **Script isn't in the list:** check that the file is in the folder from step 3, then close and reopen the Scripts panel.
- **Nothing happens when you double-click:** send me a screenshot of any message InDesign shows.
- **A red X line:** copy it to me. The other pages still export.
