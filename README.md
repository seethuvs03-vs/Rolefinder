# Rolefinder

Rolefinder runs on GitHub Pages. GitHub Actions builds the site and refreshes public job data every six hours. A computer or external server does not need to stay on.

## Deploy on your GitHub account

1. Push this project to the `main` branch of your GitHub repository.
2. In the repository's **Settings → Pages**, under **Build and deployment**, choose **GitHub Actions** as the source.
3. Open **Actions → Publish Rolefinder**, then choose **Run workflow**. Open the Pages URL from the deployment summary.

GitHub Free supports Pages from public repositories. Publishing from a private personal repository requires GitHub Pro, and the Pages site is still publicly reachable. Neither option stores your resume or preferences in the repository or on the site host. Preferences are saved in the browser and the resume stays in memory in the current tab. The site loads a public jobs snapshot. **Save & find jobs** and **Refresh** also check Arbeitnow and Remote OK directly. Infopark updates through the scheduled snapshot. The app displays which sources were checked live and the snapshot timestamp. GitHub may delay scheduled runs.

## Use the app

- Save titles, locations, work arrangements, employment types, and keyword filters. Comma-separated titles and locations use OR. All required terms must appear and any excluded term removes a listing.
- Listings come from Arbeitnow, Remote OK, and a selection of recent data and quality postings from Infopark Kerala. A Kerala search also matches major Kerala cities in source locations. Related data-quality roles are labeled and shown below direct title matches. The snapshot also includes a bounded selection of recent employer postings in India, the UAE, and Qatar from Accor, AECOM, Turner & Townsend, Bosch, NielsenIQ, Endava, and BESIX. For these employer postings, keyword filters use listing metadata until the full description is loaded when you open a job. Coverage varies by country and occupation. Location and arrangement filters use metadata supplied by the sources.
- Upload a text-based PDF, DOCX, or TXT resume and choose a job. Tailoring uses existing resume text to prioritize experience relevant to the listing in an editable professional summary. For DOCX and TXT resumes with a recognizable summary heading and an editable first summary paragraph, the download updates that paragraph in the original file. For PDFs and other layouts, copy the edited summary into your original resume.
- Use the original listing to apply.
