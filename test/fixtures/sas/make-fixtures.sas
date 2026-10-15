/* Regenerates the SAS fixtures from SASHELP data (no project data, no paths in the output).
   Run with:  sas -sysin make-fixtures.sas -set OUTDIR <folder>   (or %let outdir=<folder>; first) */
%let outdir = %sysget(OUTDIR);
options nodate nonumber orientation=landscape;
ods escapechar='^';
ods graphics on;

/* 1. TITLE/FOOTNOTE in the page header/footer (ODS RTF default), special characters, two procedures. */
ods rtf file="&outdir/titles-footnotes.rtf" style=journal;
title1 "Table 1. Weight ^{unicode 2265} 100 lb by sex";
title2 "Mean ^{unicode 00B1} SD ^{unicode 2013} SASHELP.CLASS";
footnote1 "Footnote: values are from SASHELP.CLASS.";
proc means data=sashelp.class n mean std min max maxdec=1; class sex; var age height weight; run;
title1 "Table 2. Frequency of sex by age";
proc freq data=sashelp.class; tables sex*age / nopercent nocol norow; run;
ods rtf close;

/* 2. BODYTITLE, spanning column headers. */
ods rtf file="&outdir/bodytitle-spanning.rtf" style=journal bodytitle;
title1 "Table 3. Height and weight by sex (body titles)";
footnote1 "Spanning headers from PROC REPORT.";
proc report data=sashelp.class nowd;
  column sex ('Height' height=hmean height=hmax) ('Weight' weight=wmean weight=wmax);
  define sex / group;
  define hmean / analysis mean 'Mean' format=6.1;
  define hmax / analysis max 'Max' format=6.1;
  define wmean / analysis mean 'Mean' format=6.1;
  define wmax / analysis max 'Max' format=6.1;
run;
ods rtf close;

/* 3. A graph as PNG and 4. the same graph in the default EMF format. */
title1 "Figure 1. Weight by height";
footnote;
ods rtf file="&outdir/graph-png.rtf" style=journal;
ods graphics / outputfmt=png width=5in height=3.5in;
proc sgplot data=sashelp.class; scatter x=height y=weight / group=sex; run;
ods rtf close;
ods graphics / reset;
ods rtf file="&outdir/graph-emf.rtf" style=journal;
proc sgplot data=sashelp.class; scatter x=height y=weight / group=sex; run;
ods rtf close;
