pub(super) fn clean_ocr_text(text: &str) -> String {
    let normalized = strip_wrapping_code_fence(text.trim())
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();
    let collapsed = collapse_repeated_ocr_text(&normalized);
    trim_trailing_ocr_artifacts(&collapsed)
}

fn trim_trailing_ocr_artifacts(text: &str) -> String {
    let mut lines = text.lines().collect::<Vec<_>>();

    loop {
        let before = lines.len();
        while lines
            .last()
            .is_some_and(|line| line.trim().is_empty() || is_pipe_only_line(line))
        {
            lines.pop();
        }

        if remove_trailing_empty_code_fence(&mut lines) {
            continue;
        }

        if lines.len() == before {
            break;
        }
    }

    lines.join("\n").trim().to_string()
}

fn remove_trailing_empty_code_fence(lines: &mut Vec<&str>) -> bool {
    let Some(last_marker) = lines.last().and_then(|line| code_fence_marker(line)) else {
        return false;
    };

    for index in (0..lines.len().saturating_sub(1)).rev() {
        if code_fence_marker(lines[index]) != Some(last_marker) {
            continue;
        }

        let empty_body = lines[index + 1..lines.len() - 1]
            .iter()
            .all(|line| line.trim().is_empty() || is_pipe_only_line(line));
        if empty_body {
            lines.truncate(index);
            return true;
        }
        return false;
    }

    lines.pop();
    true
}

fn code_fence_marker(line: &str) -> Option<char> {
    let trimmed = line.trim_start();
    if trimmed.starts_with("```") {
        Some('`')
    } else if trimmed.starts_with("~~~") {
        Some('~')
    } else {
        None
    }
}

fn is_pipe_only_line(line: &str) -> bool {
    let trimmed = line.trim();
    !trimmed.is_empty() && trimmed.chars().all(|ch| ch == '|' || ch.is_whitespace())
}

fn collapse_repeated_ocr_text(text: &str) -> String {
    let line_collapsed = collapse_repeated_line_cycle(text);
    let block_collapsed = collapse_repeated_block_cycle(&line_collapsed);
    collapse_adjacent_duplicate_blocks(&block_collapsed)
}

fn collapse_repeated_line_cycle(text: &str) -> String {
    let lines = text.lines().map(ToString::to_string).collect::<Vec<_>>();
    collapse_repeated_units(&lines)
        .map(|collapsed| collapsed.join("\n").trim().to_string())
        .unwrap_or_else(|| text.to_string())
}

fn collapse_repeated_block_cycle(text: &str) -> String {
    let blocks = markdown_blocks(text);
    collapse_repeated_units(&blocks)
        .map(|collapsed| collapsed.join("\n\n").trim().to_string())
        .unwrap_or_else(|| text.to_string())
}

fn collapse_adjacent_duplicate_blocks(text: &str) -> String {
    let blocks = markdown_blocks(text);
    if blocks.len() < 2 {
        return text.to_string();
    }

    let mut collapsed = Vec::new();
    let mut previous_key = String::new();
    for block in blocks {
        let key = repeat_key(&block);
        if !key.is_empty() && key == previous_key {
            continue;
        }
        previous_key = key;
        collapsed.push(block);
    }

    collapsed.join("\n\n").trim().to_string()
}

fn collapse_repeated_units(units: &[String]) -> Option<Vec<String>> {
    if units.len() < 2 {
        return None;
    }

    let keys = units
        .iter()
        .map(|unit| repeat_key(unit))
        .collect::<Vec<_>>();
    for cycle_len in 1..=units.len() / 2 {
        if units.len() % cycle_len != 0 {
            continue;
        }

        let repeat_count = units.len() / cycle_len;
        if repeat_count < 2 || (repeat_count == 2 && cycle_len == 1) {
            continue;
        }
        if keys[..cycle_len].iter().all(|key| key.is_empty()) {
            continue;
        }

        let is_cycle = (cycle_len..units.len()).all(|index| keys[index] == keys[index % cycle_len]);
        if is_cycle {
            return Some(units[..cycle_len].to_vec());
        }
    }

    None
}

fn markdown_blocks(text: &str) -> Vec<String> {
    let mut blocks = Vec::new();
    let mut current = Vec::new();
    for line in text.lines() {
        if line.trim().is_empty() {
            if !current.is_empty() {
                blocks.push(current.join("\n"));
                current.clear();
            }
        } else {
            current.push(line);
        }
    }
    if !current.is_empty() {
        blocks.push(current.join("\n"));
    }
    blocks
}

fn repeat_key(value: &str) -> String {
    value
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn strip_wrapping_code_fence(text: &str) -> &str {
    let trimmed = text.trim();
    if !trimmed.starts_with("```") || !trimmed.ends_with("```") {
        return trimmed;
    }

    let mut lines = trimmed.lines();
    let Some(first) = lines.next() else {
        return trimmed;
    };
    if !first.trim_start().starts_with("```") {
        return trimmed;
    }

    let without_first = trimmed[first.len()..].trim_start_matches(['\r', '\n']);
    let Some(last_index) = without_first.rfind("```") else {
        return trimmed;
    };
    if without_first[last_index..].trim() != "```" {
        return trimmed;
    }

    without_first[..last_index].trim()
}

pub(super) fn extract_ocr_text(body: &serde_json::Value) -> Option<String> {
    let response = body.get("response").and_then(|value| value.as_str())?;
    let response = strip_wrapping_code_fence(response);
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(response) {
        if let Some(text) = value.get("text").and_then(|value| value.as_str()) {
            let cleaned = clean_ocr_text(text);
            return (!cleaned.is_empty()).then_some(cleaned);
        }
    }

    let cleaned = clean_ocr_text(response);
    (!cleaned.is_empty()).then_some(cleaned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_only_wrapping_markdown_fence() {
        assert_eq!(
            clean_ocr_text("```markdown\n# 标题\n- 项目\n```"),
            "# 标题\n- 项目"
        );
    }

    #[test]
    fn removes_trailing_empty_ocr_artifacts() {
        let noisy = [
            "| Service | Port |",
            "| --- | --- |",
            "| Ollama | 11434 |",
            "",
            "```",
            "```",
            "",
            "|",
            "|",
            "",
            "~~~",
            "~~~",
        ]
        .join("\n");

        assert_eq!(
            clean_ocr_text(&noisy),
            ["| Service | Port |", "| --- | --- |", "| Ollama | 11434 |"].join("\n")
        );
    }

    #[test]
    fn preserves_internal_markdown_code_fences() {
        let markdown = "# 代码\n```ts\nconst ok = true\n```\n- done";
        assert_eq!(clean_ocr_text(markdown), markdown);
    }

    #[test]
    fn collapses_repeated_full_ocr_cycles() {
        let repeated = [
            "验证跑过：",
            "",
            "• npm test -- --run src/components/HomePage/__tests__/Workbench.test.tsx",
            "• cargo check --manifest-path src-tauri/Cargo.toml",
            "",
            "验证跑过：",
            "",
            "• npm test -- --run src/components/HomePage/__tests__/Workbench.test.tsx",
            "• cargo check --manifest-path src-tauri/Cargo.toml",
        ]
        .join("\n");

        assert_eq!(
            clean_ocr_text(&repeated),
            [
                "验证跑过：",
                "",
                "• npm test -- --run src/components/HomePage/__tests__/Workbench.test.tsx",
                "• cargo check --manifest-path src-tauri/Cargo.toml",
            ]
            .join("\n")
        );
    }

    #[test]
    fn collapses_adjacent_duplicate_ocr_blocks() {
        let repeated = "订单号 123\n状态 待确认\n\n订单号 123\n状态 待确认\n\n下一段";

        assert_eq!(
            clean_ocr_text(repeated),
            "订单号 123\n状态 待确认\n\n下一段"
        );
    }

    #[test]
    fn extracts_json_formatted_ocr_response() {
        let body = serde_json::json!({
            "response": "{\"text\":\"EcholIKE OCR TEST 123\"}"
        });

        assert_eq!(
            extract_ocr_text(&body).as_deref(),
            Some("EcholIKE OCR TEST 123")
        );
    }

    #[test]
    fn extracts_markdown_from_json_formatted_ocr_response() {
        let body = serde_json::json!({
            "response": "{\"text\":\"# 订单\\n\\n- 编号：12345\\n- 状态：待确认\"}"
        });

        assert_eq!(
            extract_ocr_text(&body).as_deref(),
            Some("# 订单\n\n- 编号：12345\n- 状态：待确认")
        );
    }

    #[test]
    fn extracts_json_when_model_wraps_response_in_code_fence() {
        let body = serde_json::json!({
            "response": "```json\n{\"text\":\"# 标题\\n正文\"}\n```"
        });

        assert_eq!(extract_ocr_text(&body).as_deref(), Some("# 标题\n正文"));
    }
}
