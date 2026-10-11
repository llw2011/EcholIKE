use super::{export_safe_base_name, MarkdownDocxExportResult};
use std::io::{Cursor, Write};

#[derive(Debug, Clone, PartialEq, Eq)]
enum MarkdownDocxBlock {
    Heading {
        level: u8,
        text: String,
    },
    Paragraph(String),
    List {
        ordered: bool,
        items: Vec<String>,
    },
    Table {
        headers: Vec<String>,
        rows: Vec<Vec<String>>,
    },
    Code(String),
}

fn markdown_docx_file_name(source_name: &str) -> String {
    format!(
        "{}.docx",
        export_safe_base_name(source_name, "echolike-ocr")
    )
}

fn parse_markdown_docx_blocks(markdown: &str) -> Vec<MarkdownDocxBlock> {
    let normalized = markdown.replace("\r\n", "\n").replace('\r', "\n");
    let lines = normalized.lines().collect::<Vec<_>>();
    let mut blocks = Vec::new();
    let mut index = 0;

    while index < lines.len() {
        let line = lines[index];
        let trimmed = line.trim();
        if trimmed.is_empty() {
            index += 1;
            continue;
        }

        if trimmed.starts_with("```") {
            let mut code_lines = Vec::new();
            index += 1;
            while index < lines.len() && !lines[index].trim().starts_with("```") {
                code_lines.push(lines[index]);
                index += 1;
            }
            if index < lines.len() {
                index += 1;
            }
            blocks.push(MarkdownDocxBlock::Code(code_lines.join("\n")));
            continue;
        }

        if is_docx_markdown_table(&lines, index) {
            let headers = split_docx_table_row(lines[index]);
            let mut rows = Vec::new();
            index += 2;
            while index < lines.len() && split_docx_table_row(lines[index]).len() >= 2 {
                rows.push(split_docx_table_row(lines[index]));
                index += 1;
            }
            blocks.push(MarkdownDocxBlock::Table { headers, rows });
            continue;
        }

        if let Some((level, text)) = parse_docx_heading(trimmed) {
            blocks.push(MarkdownDocxBlock::Heading { level, text });
            index += 1;
            continue;
        }

        if let Some(items) = collect_docx_list_items(&lines, &mut index, false) {
            blocks.push(MarkdownDocxBlock::List {
                ordered: false,
                items,
            });
            continue;
        }

        if let Some(items) = collect_docx_list_items(&lines, &mut index, true) {
            blocks.push(MarkdownDocxBlock::List {
                ordered: true,
                items,
            });
            continue;
        }

        let mut paragraph_lines = vec![line.trim_end()];
        index += 1;
        while index < lines.len() && !lines[index].trim().is_empty() {
            if is_docx_markdown_block_start(&lines, index) {
                break;
            }
            paragraph_lines.push(lines[index].trim_end());
            index += 1;
        }
        blocks.push(MarkdownDocxBlock::Paragraph(
            paragraph_lines.join("\n").trim().to_string(),
        ));
    }

    if blocks.is_empty() {
        vec![MarkdownDocxBlock::Paragraph(markdown.trim().to_string())]
    } else {
        blocks
    }
}

fn parse_docx_heading(trimmed: &str) -> Option<(u8, String)> {
    let hashes = trimmed.chars().take_while(|ch| *ch == '#').count();
    if !(1..=6).contains(&hashes) {
        return None;
    }
    let rest = trimmed.get(hashes..)?.trim_start();
    if rest.is_empty() {
        return None;
    }
    Some((hashes as u8, rest.to_string()))
}

fn collect_docx_list_items(
    lines: &[&str],
    index: &mut usize,
    ordered: bool,
) -> Option<Vec<String>> {
    let mut items = Vec::new();
    while *index < lines.len() {
        let item = if ordered {
            parse_ordered_docx_item(lines[*index])
        } else {
            parse_unordered_docx_item(lines[*index])
        };

        let Some(item) = item else {
            break;
        };
        items.push(item);
        *index += 1;
    }

    if items.is_empty() {
        None
    } else {
        Some(items)
    }
}

fn parse_unordered_docx_item(line: &str) -> Option<String> {
    let trimmed = line.trim_start();
    let marker = trimmed.chars().next()?;
    if !matches!(marker, '-' | '*' | '+') {
        return None;
    }
    let rest = trimmed.get(marker.len_utf8()..)?;
    if !rest.starts_with(char::is_whitespace) {
        return None;
    }
    Some(rest.trim().to_string())
}

fn parse_ordered_docx_item(line: &str) -> Option<String> {
    let trimmed = line.trim_start();
    let marker_index = trimmed.find(|ch: char| !ch.is_ascii_digit())?;
    if marker_index == 0 {
        return None;
    }
    let marker = trimmed.get(marker_index..)?.chars().next()?;
    if !matches!(marker, '.' | ')') {
        return None;
    }
    let rest = trimmed.get(marker_index + marker.len_utf8()..)?;
    if !rest.starts_with(char::is_whitespace) {
        return None;
    }
    Some(rest.trim().to_string())
}

fn is_docx_markdown_block_start(lines: &[&str], index: usize) -> bool {
    let trimmed = lines[index].trim();
    trimmed.starts_with("```")
        || parse_docx_heading(trimmed).is_some()
        || parse_unordered_docx_item(lines[index]).is_some()
        || parse_ordered_docx_item(lines[index]).is_some()
        || is_docx_markdown_table(lines, index)
}

fn is_docx_markdown_table(lines: &[&str], index: usize) -> bool {
    if index + 1 >= lines.len() {
        return false;
    }
    let header = split_docx_table_row(lines[index]);
    let divider = split_docx_table_row(lines[index + 1]);
    header.len() >= 2
        && divider.len() == header.len()
        && divider.iter().all(|cell| {
            let compact = cell.replace(char::is_whitespace, "");
            compact.len() >= 3
                && compact.trim_matches(':').chars().all(|ch| ch == '-')
                && compact.contains('-')
        })
}

fn split_docx_table_row(line: &str) -> Vec<String> {
    let trimmed = line.trim();
    if !trimmed.contains('|') {
        return Vec::new();
    }

    let content = trimmed.trim_start_matches('|').trim_end_matches('|');
    let mut cells = Vec::new();
    let mut current = String::new();
    let mut escaped = false;
    let mut in_code = false;

    for ch in content.chars() {
        if escaped {
            if ch != '|' {
                current.push('\\');
            }
            current.push(ch);
            escaped = false;
            continue;
        }

        if ch == '\\' {
            escaped = true;
            continue;
        }

        if ch == '`' {
            in_code = !in_code;
            current.push(ch);
            continue;
        }

        if ch == '|' && !in_code {
            cells.push(current.trim().to_string());
            current.clear();
            continue;
        }

        current.push(ch);
    }

    if escaped {
        current.push('\\');
    }
    cells.push(current.trim().to_string());
    cells
}

fn xml_escape(value: &str) -> String {
    value
        .chars()
        .map(|ch| match ch {
            '&' => "&amp;".to_string(),
            '<' => "&lt;".to_string(),
            '>' => "&gt;".to_string(),
            '"' => "&quot;".to_string(),
            '\'' => "&apos;".to_string(),
            '\u{0}'..='\u{8}' | '\u{b}' | '\u{c}' | '\u{e}'..='\u{1f}' => " ".to_string(),
            _ => ch.to_string(),
        })
        .collect()
}

fn docx_text_nodes_xml(text: &str) -> String {
    let mut xml = String::new();
    for (index, line) in text.split('\n').enumerate() {
        if index > 0 {
            xml.push_str("<w:br/>");
        }
        if line.is_empty() {
            continue;
        }
        let space = if line.starts_with(char::is_whitespace) || line.ends_with(char::is_whitespace)
        {
            " xml:space=\"preserve\""
        } else {
            ""
        };
        xml.push_str(&format!("<w:t{space}>{}</w:t>", xml_escape(line)));
    }

    if xml.is_empty() {
        "<w:t></w:t>".to_string()
    } else {
        xml
    }
}

fn docx_run_xml(text: &str, run_props: &str) -> String {
    let props = if run_props.is_empty() {
        String::new()
    } else {
        format!("<w:rPr>{run_props}</w:rPr>")
    };
    format!("<w:r>{props}{}</w:r>", docx_text_nodes_xml(text))
}

fn docx_inline_runs_xml(text: &str, base_run_props: &str) -> String {
    let mut xml = String::new();
    let mut rest = text;

    while !rest.is_empty() {
        let bold_pos = rest.find("**");
        let code_pos = rest.find('`');
        let next_pos = match (bold_pos, code_pos) {
            (Some(left), Some(right)) => left.min(right),
            (Some(pos), None) | (None, Some(pos)) => pos,
            (None, None) => {
                xml.push_str(&docx_run_xml(rest, base_run_props));
                break;
            }
        };

        if next_pos > 0 {
            xml.push_str(&docx_run_xml(&rest[..next_pos], base_run_props));
            rest = &rest[next_pos..];
            continue;
        }

        if rest.starts_with("**") {
            if let Some(end) = rest[2..].find("**") {
                let content = &rest[2..2 + end];
                let props = format!("{base_run_props}<w:b/>");
                xml.push_str(&docx_run_xml(content, &props));
                rest = &rest[2 + end + 2..];
                continue;
            }
        }

        if rest.starts_with('`') {
            if let Some(end) = rest[1..].find('`') {
                let content = &rest[1..1 + end];
                let props = format!(
                    "{base_run_props}<w:rFonts w:ascii=\"Consolas\" w:hAnsi=\"Consolas\" w:eastAsia=\"Consolas\"/><w:color w:val=\"555555\"/>"
                );
                xml.push_str(&docx_run_xml(content, &props));
                rest = &rest[1 + end + 1..];
                continue;
            }
        }

        xml.push_str(&docx_run_xml(rest, base_run_props));
        break;
    }

    if xml.is_empty() {
        docx_run_xml("", base_run_props)
    } else {
        xml
    }
}

fn docx_paragraph_xml(text: &str, paragraph_props: &str, run_props: &str) -> String {
    let props = if paragraph_props.is_empty() {
        String::new()
    } else {
        format!("<w:pPr>{paragraph_props}</w:pPr>")
    };
    format!(
        "<w:p>{props}{}</w:p>",
        docx_inline_runs_xml(text, run_props)
    )
}

fn docx_code_paragraph_xml(code: &str) -> String {
    let paragraph_props = [
        "<w:spacing w:before=\"120\" w:after=\"120\"/>",
        "<w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"F3F4F6\"/>",
    ]
    .join("");
    let run_props = "<w:rFonts w:ascii=\"Consolas\" w:hAnsi=\"Consolas\" w:eastAsia=\"Consolas\"/><w:sz w:val=\"20\"/>";
    format!(
        "<w:p><w:pPr>{paragraph_props}</w:pPr>{}</w:p>",
        docx_run_xml(code, run_props)
    )
}

fn docx_page_break_xml() -> &'static str {
    "<w:p><w:r><w:br w:type=\"page\"/></w:r></w:p>"
}

fn docx_page_heading_number(level: u8, text: &str) -> Option<u32> {
    if level > 3 {
        return None;
    }

    let trimmed = text.trim();
    if let Some(rest) = trimmed
        .strip_prefix('第')
        .and_then(|value| value.strip_suffix('页'))
    {
        return rest.trim().parse::<u32>().ok();
    }

    let lower = trimmed.to_ascii_lowercase();
    lower
        .strip_prefix("page ")
        .and_then(|rest| rest.trim().parse::<u32>().ok())
}

fn docx_table_xml(headers: &[String], rows: &[Vec<String>]) -> String {
    let column_count = headers
        .len()
        .max(rows.iter().map(Vec::len).max().unwrap_or(0))
        .max(1);
    let cell_width = (9000 / column_count).max(1200);
    let mut xml = String::new();
    xml.push_str("<w:tbl><w:tblPr><w:tblW w:w=\"0\" w:type=\"auto\"/><w:tblBorders><w:top w:val=\"single\" w:sz=\"6\" w:space=\"0\" w:color=\"D1D5DB\"/><w:left w:val=\"single\" w:sz=\"6\" w:space=\"0\" w:color=\"D1D5DB\"/><w:bottom w:val=\"single\" w:sz=\"6\" w:space=\"0\" w:color=\"D1D5DB\"/><w:right w:val=\"single\" w:sz=\"6\" w:space=\"0\" w:color=\"D1D5DB\"/><w:insideH w:val=\"single\" w:sz=\"6\" w:space=\"0\" w:color=\"D1D5DB\"/><w:insideV w:val=\"single\" w:sz=\"6\" w:space=\"0\" w:color=\"D1D5DB\"/></w:tblBorders></w:tblPr><w:tblGrid>");
    for _ in 0..column_count {
        xml.push_str(&format!("<w:gridCol w:w=\"{cell_width}\"/>"));
    }
    xml.push_str("</w:tblGrid>");

    let mut write_row = |cells: Vec<String>, header: bool| {
        xml.push_str("<w:tr>");
        for column in 0..column_count {
            let value = cells.get(column).map(String::as_str).unwrap_or("");
            let shading = if header {
                "<w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"EEF2F7\"/>"
            } else {
                ""
            };
            let run_props = if header { "<w:b/>" } else { "" };
            xml.push_str(&format!(
                "<w:tc><w:tcPr><w:tcW w:w=\"{cell_width}\" w:type=\"dxa\"/>{shading}</w:tcPr>{}</w:tc>",
                docx_paragraph_xml(value, "", run_props)
            ));
        }
        xml.push_str("</w:tr>");
    };

    write_row(headers.to_vec(), true);
    for row in rows {
        write_row(row.clone(), false);
    }
    xml.push_str("</w:tbl>");
    xml
}

fn markdown_document_xml(markdown: &str, insert_page_breaks: bool) -> String {
    let blocks = parse_markdown_docx_blocks(markdown);
    let mut body = String::new();
    let mut has_content = false;

    for block in blocks {
        match block {
            MarkdownDocxBlock::Heading { level, text } => {
                let level = level.clamp(1, 6);
                if insert_page_breaks
                    && has_content
                    && docx_page_heading_number(level, &text).is_some_and(|n| n > 1)
                {
                    body.push_str(docx_page_break_xml());
                }
                body.push_str(&docx_paragraph_xml(
                    &text,
                    &format!("<w:pStyle w:val=\"Heading{level}\"/>"),
                    "",
                ));
                has_content = true;
            }
            MarkdownDocxBlock::Paragraph(text) => {
                body.push_str(&docx_paragraph_xml(&text, "", ""));
                has_content = true;
            }
            MarkdownDocxBlock::List { ordered, items } => {
                let num_id = if ordered { 2 } else { 1 };
                for item in items {
                    body.push_str(&docx_paragraph_xml(
                        &item,
                        &format!(
                            "<w:numPr><w:ilvl w:val=\"0\"/><w:numId w:val=\"{num_id}\"/></w:numPr>"
                        ),
                        "",
                    ));
                }
                has_content = true;
            }
            MarkdownDocxBlock::Table { headers, rows } => {
                body.push_str(&docx_table_xml(&headers, &rows));
                body.push_str(&docx_paragraph_xml("", "", ""));
                has_content = true;
            }
            MarkdownDocxBlock::Code(code) => {
                body.push_str(&docx_code_paragraph_xml(&code));
                has_content = true;
            }
        }
    }

    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>"#
    )
}

fn docx_content_types_xml() -> &'static str {
    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>"#
}

fn docx_root_rels_xml() -> &'static str {
    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>"#
}

fn docx_document_rels_xml() -> &'static str {
    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>"#
}

fn docx_styles_xml() -> &'static str {
    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Microsoft YaHei"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="220" w:after="100"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="200" w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="25"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:rPr><w:b/><w:sz w:val="23"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading5"><w:name w:val="heading 5"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:rPr><w:b/><w:sz w:val="22"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading6"><w:name w:val="heading 6"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:rPr><w:b/><w:sz w:val="21"/></w:rPr></w:style></w:styles>"#
}

fn docx_numbering_xml() -> &'static str {
    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>"#
}

fn docx_core_xml() -> &'static str {
    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>EcholIKE</dc:creator><cp:lastModifiedBy>EcholIKE</cp:lastModifiedBy><dc:title>OCR Markdown Export</dc:title></cp:coreProperties>"#
}

fn docx_app_xml() -> &'static str {
    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>EcholIKE</Application></Properties>"#
}

fn write_zip_text(
    archive: &mut zip::ZipWriter<Cursor<Vec<u8>>>,
    path: &str,
    content: &str,
) -> Result<(), String> {
    let options =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    archive
        .start_file(path, options)
        .map_err(|e| format!("DOCX zip failed: {e}"))?;
    archive
        .write_all(content.as_bytes())
        .map_err(|e| format!("DOCX zip write failed: {e}"))
}

pub(super) fn build_markdown_docx_export(
    source_name: &str,
    markdown: &str,
    insert_page_breaks: bool,
) -> Result<MarkdownDocxExportResult, String> {
    if markdown.trim().is_empty() {
        return Err("Markdown content is empty".to_string());
    }

    let cursor = Cursor::new(Vec::new());
    let mut archive = zip::ZipWriter::new(cursor);
    write_zip_text(
        &mut archive,
        "[Content_Types].xml",
        docx_content_types_xml(),
    )?;
    write_zip_text(&mut archive, "_rels/.rels", docx_root_rels_xml())?;
    write_zip_text(
        &mut archive,
        "word/_rels/document.xml.rels",
        docx_document_rels_xml(),
    )?;
    write_zip_text(&mut archive, "word/styles.xml", docx_styles_xml())?;
    write_zip_text(&mut archive, "word/numbering.xml", docx_numbering_xml())?;
    write_zip_text(&mut archive, "docProps/core.xml", docx_core_xml())?;
    write_zip_text(&mut archive, "docProps/app.xml", docx_app_xml())?;
    write_zip_text(
        &mut archive,
        "word/document.xml",
        &markdown_document_xml(markdown, insert_page_breaks),
    )?;

    let cursor = archive
        .finish()
        .map_err(|e| format!("DOCX zip finalize failed: {e}"))?;

    Ok(MarkdownDocxExportResult {
        file_name: markdown_docx_file_name(source_name),
        mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            .to_string(),
        file_bytes: cursor.into_inner(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn builds_markdown_docx_with_native_blocks() {
        let markdown = [
            "# 订单",
            "",
            "- 确认地址",
            "- 联系客户",
            "",
            "| 字段 | 值 |",
            "| --- | --- |",
            "| 状态 | 待确认 |",
            "| 备注 | A \\| B |",
            "",
            "```text",
            "复制码 ABC",
            "```",
            "",
            "控制\u{8}字符 & < >",
        ]
        .join("\n");

        let result = build_markdown_docx_export("bad:/report.pdf", &markdown, false).unwrap();

        assert_eq!(result.file_name, "bad-report.docx");
        assert_eq!(
            result.mime_type,
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        );
        assert!(result.file_bytes.starts_with(b"PK"));

        let mut archive = zip::ZipArchive::new(Cursor::new(result.file_bytes)).unwrap();
        assert!(archive.by_name("[Content_Types].xml").is_ok());
        assert!(archive.by_name("word/numbering.xml").is_ok());

        let mut document_xml = String::new();
        {
            let mut document = archive.by_name("word/document.xml").unwrap();
            std::io::Read::read_to_string(&mut document, &mut document_xml).unwrap();
        }

        assert!(document_xml.contains("<w:pStyle w:val=\"Heading1\"/>"));
        assert!(document_xml.contains("<w:numPr>"));
        assert!(document_xml.contains("<w:tbl>"));
        assert!(document_xml.contains("待确认"));
        assert!(document_xml.contains("A | B"));
        assert!(document_xml.contains("复制码 ABC"));
        assert!(document_xml.contains("控制 字符 &amp; &lt; &gt;"));
        assert!(!document_xml.contains('\u{8}'));
    }

    #[test]
    fn inserts_docx_page_breaks_before_later_pdf_pages() {
        let markdown = [
            "## 第 1 页",
            "",
            "第一页内容",
            "",
            "## 第 2 页",
            "",
            "第二页内容",
            "",
            "## Page 3",
            "",
            "third page",
        ]
        .join("\n");

        let result = build_markdown_docx_export("report.pdf", &markdown, true).unwrap();
        let mut archive = zip::ZipArchive::new(Cursor::new(result.file_bytes)).unwrap();
        let mut document_xml = String::new();
        {
            let mut document = archive.by_name("word/document.xml").unwrap();
            std::io::Read::read_to_string(&mut document, &mut document_xml).unwrap();
        }

        assert_eq!(document_xml.matches("<w:br w:type=\"page\"/>").count(), 2);
        assert!(document_xml.find("第 1 页").unwrap() < document_xml.find("第 2 页").unwrap());
        assert!(document_xml.find("第 2 页").unwrap() < document_xml.find("Page 3").unwrap());
    }

    #[test]
    fn leaves_page_headings_unbroken_for_single_page_docx_exports() {
        let markdown = ["## 第 2 页", "", "普通内容里提到了页码"].join("\n");

        let result = build_markdown_docx_export("screen.md", &markdown, false).unwrap();
        let mut archive = zip::ZipArchive::new(Cursor::new(result.file_bytes)).unwrap();
        let mut document_xml = String::new();
        {
            let mut document = archive.by_name("word/document.xml").unwrap();
            std::io::Read::read_to_string(&mut document, &mut document_xml).unwrap();
        }

        assert!(!document_xml.contains("<w:br w:type=\"page\"/>"));
        assert!(document_xml.contains("第 2 页"));
    }
}
