package org.pycam.bizcard

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface

/**
 * [MyCard] 를 표준 명함 비율(85.6:54)의 그림으로 그린다.
 * 템플릿마다 배치만 다르고 글자 크기는 모두 카드 높이에 비례해 정한다.
 */
object CardRenderer {

    /**
     * [width] 픽셀 폭으로 명함을 그린다. 높이는 명함 비율에 맞춰 자동으로 정한다.
     *
     * [logo] 는 명함에 얹을 회사 로고다. 파일을 읽는 일은 화면 쪽에서 하고 여기에는
     * 이미 읽어 둔 비트맵을 넘긴다. QR 은 담을 내용만 있으면 여기서 직접 만든다.
     */
    fun render(
        card: MyCard,
        width: Int = CardTemplates.RENDER_WIDTH,
        logo: Bitmap? = null
    ): Bitmap {
        val safeWidth = width.coerceAtLeast(240)
        val height = (safeWidth / CardCrop.CARD_ASPECT).toInt().coerceAtLeast(1)
        val bitmap = Bitmap.createBitmap(safeWidth, height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        draw(canvas, card, safeWidth.toFloat(), height.toFloat(), logo)
        return bitmap
    }

    private fun draw(canvas: Canvas, card: MyCard, w: Float, h: Float, logo: Bitmap?) {
        val template = card.template
        val accent = card.resolvedAccent()
        val background = if (template.layout == CardTemplate.Layout.BOLD) accent else template.background
        canvas.drawColor(background)

        // QR 은 오른쪽 아래에 들어간다. 연락처 줄이 그 밑으로 흘러들지 않도록 폭을 미리 떼어 둔다.
        val payload = card.barcodePayload()
        val qr = if (payload == null) null else BarcodeRenderer.render(payload, (h * QR_FRACTION).toInt())
        val reserve = if (qr == null) 0f else w * PADDING + qr.width + w * QR_GAP

        when (template.layout) {
            CardTemplate.Layout.SIDE_BAR -> drawSideBar(canvas, card, accent, template, w, h, reserve)
            CardTemplate.Layout.TOP_BAND -> drawTopBand(canvas, card, accent, template, w, h, reserve)
            CardTemplate.Layout.CENTERED -> drawCentered(canvas, card, accent, template, w, h, reserve)
            CardTemplate.Layout.SPLIT -> drawSplit(canvas, card, accent, template, w, h, reserve)
            CardTemplate.Layout.MINIMAL -> drawMinimal(canvas, card, accent, template, w, h, reserve)
            CardTemplate.Layout.BOLD -> drawBold(canvas, card, w, h, reserve)
        }

        if (qr != null) drawBarcode(canvas, qr, w, h)
        drawLogo(canvas, card, logo, w, h)
    }

    // ---------------------------------------------------------------- QR·로고

    /** QR 을 오른쪽 아래에 넣는다. 어떤 배경색에서도 읽히도록 흰 바탕을 깔아 준다. */
    private fun drawBarcode(canvas: Canvas, qr: Bitmap, w: Float, h: Float) {
        val pad = w * PADDING
        val left = w - pad - qr.width
        val top = h - pad - qr.height
        val plate = maxOf(qr.width * 0.06f, 2f)
        canvas.drawRect(
            left - plate,
            top - plate,
            left + qr.width + plate,
            top + qr.height + plate,
            fill(Color.WHITE)
        )
        canvas.drawBitmap(qr, left, top, null)
    }

    /** 회사 로고를 고른 자리에 얹는다. 가로세로 비율은 그대로 둔다. */
    private fun drawLogo(canvas: Canvas, card: MyCard, logo: Bitmap?, w: Float, h: Float) {
        if (logo == null || logo.isRecycled || logo.width <= 0 || logo.height <= 0) return
        val spot = card.logoSpotFor(hasLogo = true)
        if (spot == LogoPlacement.SPOT_NONE) return

        val maxWidth = w * LogoPlacement.normalizeScale(card.logoScale)
        val maxHeight = h * LOGO_MAX_HEIGHT
        val ratio = minOf(maxWidth / logo.width, maxHeight / logo.height)
        val width = logo.width * ratio
        val height = logo.height * ratio
        if (width < 1f || height < 1f) return

        val pad = w * PADDING
        val left = when (spot) {
            LogoPlacement.SPOT_TOP_LEFT -> pad
            else -> w - pad - width
        }
        val top = when (spot) {
            LogoPlacement.SPOT_BOTTOM_RIGHT -> h - pad - height
            else -> pad
        }
        canvas.drawBitmap(
            logo,
            null,
            RectF(left, top, left + width, top + height),
            Paint(Paint.ANTI_ALIAS_FLAG).apply { isFilterBitmap = true }
        )
    }

    // ---------------------------------------------------------------- 배치별 그리기

    private fun drawSideBar(
        canvas: Canvas,
        card: MyCard,
        accent: Int,
        template: CardTemplate,
        w: Float,
        h: Float,
        reserve: Float
    ) {
        canvas.drawRect(0f, 0f, w * 0.055f, h, fill(accent))

        val left = w * 0.125f
        val right = w * 0.94f
        val usable = right - left

        val afterName = drawName(canvas, card.displayName, left, h * 0.28f, usable, h, template.foreground)
        drawRole(canvas, card, left, afterName, usable, h, accent, template.foreground)
        drawContacts(canvas, card, left, h * 0.58f, usable - reserve, h, accent, template.foreground)
    }

    private fun drawTopBand(
        canvas: Canvas,
        card: MyCard,
        accent: Int,
        template: CardTemplate,
        w: Float,
        h: Float,
        reserve: Float
    ) {
        val bandHeight = h * 0.24f
        canvas.drawRect(0f, 0f, w, bandHeight, fill(accent))

        val left = w * 0.07f
        val usable = w * 0.86f
        if (card.company.isNotBlank()) {
            val paint = text(Color.WHITE, h * 0.085f, bold = true)
            canvas.drawText(
                fit(paint, card.company, usable),
                left,
                bandHeight / 2f + paint.textSize * 0.36f,
                paint
            )
        }

        val afterName = drawName(canvas, card.displayName, left, h * 0.44f, usable, h, template.foreground)
        drawRole(canvas, card, left, afterName, usable, h, accent, template.foreground)
        drawContacts(canvas, card, left, h * 0.68f, usable - reserve, h, accent, template.foreground)
    }

    private fun drawCentered(
        canvas: Canvas,
        card: MyCard,
        accent: Int,
        template: CardTemplate,
        w: Float,
        h: Float,
        reserve: Float
    ) {
        val center = w / 2f
        val usable = w * 0.84f

        val namePaint = text(template.foreground, h * 0.115f, bold = true).apply {
            textAlign = Paint.Align.CENTER
        }
        canvas.drawText(fit(namePaint, card.displayName, usable), center, h * 0.3f, namePaint)

        canvas.drawRect(center - w * 0.07f, h * 0.345f, center + w * 0.07f, h * 0.355f, fill(accent))

        val rolePaint = text(accent, h * 0.055f, bold = true).apply { textAlign = Paint.Align.CENTER }
        val role = listOfNotNull(
            card.roleLine.takeIf { it.isNotBlank() },
            card.company.takeIf { it.isNotBlank() }
        ).joinToString("  |  ")
        if (role.isNotBlank()) {
            canvas.drawText(fit(rolePaint, role, usable), center, h * 0.44f, rolePaint)
        }

        val contactPaint = text(template.foreground, h * 0.05f).apply { textAlign = Paint.Align.CENTER }
        // QR 이 들어가면 가운데를 왼쪽으로 조금 옮겨서 글자가 QR 밑으로 들어가지 않게 한다.
        val contactCenter = center - reserve / 2f
        var y = h * 0.58f
        for ((_, value) in card.contactLines()) {
            canvas.drawText(fit(contactPaint, value, usable - reserve), contactCenter, y, contactPaint)
            y += h * 0.075f
            if (y > h * 0.95f) break
        }
    }

    private fun drawSplit(
        canvas: Canvas,
        card: MyCard,
        accent: Int,
        template: CardTemplate,
        w: Float,
        h: Float,
        reserve: Float
    ) {
        val panel = w * 0.4f
        canvas.drawRect(0f, 0f, panel, h, fill(accent))

        val panelPadding = w * 0.045f
        val panelWidth = panel - panelPadding * 2f
        val namePaint = text(Color.WHITE, h * 0.095f, bold = true)
        canvas.drawText(fit(namePaint, card.displayName, panelWidth), panelPadding, h * 0.42f, namePaint)

        val rolePaint = text(0xFFEFEFEF.toInt(), h * 0.05f)
        var panelY = h * 0.52f
        for (line in listOf(card.roleLine, card.company).filter { it.isNotBlank() }) {
            canvas.drawText(fit(rolePaint, line, panelWidth), panelPadding, panelY, rolePaint)
            panelY += h * 0.07f
        }

        val left = panel + w * 0.055f
        val usable = w - left - w * 0.05f
        drawContacts(canvas, card, left, h * 0.3f, usable - reserve, h, accent, template.foreground)
    }

    private fun drawMinimal(
        canvas: Canvas,
        card: MyCard,
        accent: Int,
        template: CardTemplate,
        w: Float,
        h: Float,
        reserve: Float
    ) {
        val left = w * 0.08f
        val usable = w * 0.84f

        val namePaint = text(template.foreground, h * 0.105f, bold = true)
        canvas.drawText(fit(namePaint, card.displayName, usable), left, h * 0.27f, namePaint)
        canvas.drawRect(left, h * 0.31f, left + usable * 0.22f, h * 0.316f, fill(accent))

        val subPaint = text(0xFF666666.toInt(), h * 0.052f)
        var y = h * 0.4f
        for (line in listOf(card.roleLine, card.company, card.tagline).filter { it.isNotBlank() }) {
            canvas.drawText(fit(subPaint, line, usable), left, y, subPaint)
            y += h * 0.068f
        }

        drawContacts(
            canvas,
            card,
            left,
            maxOf(y + h * 0.04f, h * 0.62f),
            usable - reserve,
            h,
            accent,
            template.foreground
        )
    }

    private fun drawBold(canvas: Canvas, card: MyCard, w: Float, h: Float, reserve: Float) {
        val left = w * 0.08f
        val usable = w * 0.84f

        val namePaint = text(Color.WHITE, h * 0.125f, bold = true)
        canvas.drawText(fit(namePaint, card.displayName, usable), left, h * 0.32f, namePaint)

        val subPaint = text(0xFFF2F2F2.toInt(), h * 0.055f)
        var y = h * 0.42f
        for (line in listOf(card.roleLine, card.company).filter { it.isNotBlank() }) {
            canvas.drawText(fit(subPaint, line, usable), left, y, subPaint)
            y += h * 0.07f
        }

        val contactPaint = text(0xFFFFFFFF.toInt(), h * 0.048f)
        var contactY = maxOf(y + h * 0.05f, h * 0.66f)
        for ((_, value) in card.contactLines()) {
            canvas.drawText(fit(contactPaint, value, usable - reserve), left, contactY, contactPaint)
            contactY += h * 0.072f
            if (contactY > h * 0.97f) break
        }
    }

    // ---------------------------------------------------------------- 공통 조각

    /** 이름을 그리고 다음 줄의 기준선을 돌려준다. */
    private fun drawName(
        canvas: Canvas,
        name: String,
        left: Float,
        baseline: Float,
        usable: Float,
        h: Float,
        color: Int
    ): Float {
        val paint = text(color, h * 0.115f, bold = true)
        canvas.drawText(fit(paint, name, usable), left, baseline, paint)
        return baseline + h * 0.085f
    }

    /** 부서·직함과 회사를 그리고 다음 줄의 기준선을 돌려준다. */
    private fun drawRole(
        canvas: Canvas,
        card: MyCard,
        left: Float,
        baseline: Float,
        usable: Float,
        h: Float,
        accent: Int,
        color: Int
    ): Float {
        var y = baseline
        if (card.roleLine.isNotBlank()) {
            val paint = text(accent, h * 0.055f, bold = true)
            canvas.drawText(fit(paint, card.roleLine, usable), left, y, paint)
            y += h * 0.07f
        }
        if (card.company.isNotBlank()) {
            val paint = text(color, h * 0.058f)
            canvas.drawText(fit(paint, card.company, usable), left, y, paint)
            y += h * 0.07f
        }
        if (card.tagline.isNotBlank()) {
            val paint = text(0xFF777777.toInt(), h * 0.046f, italic = true)
            canvas.drawText(fit(paint, card.tagline, usable), left, y, paint)
            y += h * 0.062f
        }
        return y
    }

    /** 연락처 항목을 "M 010-…" 처럼 라벨과 함께 세로로 쌓는다. */
    private fun drawContacts(
        canvas: Canvas,
        card: MyCard,
        left: Float,
        baseline: Float,
        usable: Float,
        h: Float,
        accent: Int,
        color: Int
    ) {
        val labelPaint = text(accent, h * 0.042f, bold = true)
        val valuePaint = text(color, h * 0.047f)
        val labelWidth = h * 0.05f
        var y = baseline

        for ((label, value) in card.contactLines()) {
            if (y > h * 0.97f) break
            canvas.drawText(label, left, y, labelPaint)
            canvas.drawText(fit(valuePaint, value, usable - labelWidth), left + labelWidth, y, valuePaint)
            y += h * 0.068f
        }
    }

    /** 테두리 여백. 명함 가로 길이에 대한 비율. */
    private const val PADDING = 0.045f

    /** QR 한 변. 명함 세로 길이에 대한 비율. */
    private const val QR_FRACTION = 0.3f

    /** QR 과 글자 사이에 두는 틈. 명함 가로 길이에 대한 비율. */
    private const val QR_GAP = 0.03f

    /** 로고 세로 길이의 한계. 명함 세로 길이에 대한 비율. */
    private const val LOGO_MAX_HEIGHT = 0.3f

    private fun fill(color: Int) = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        this.color = color
        style = Paint.Style.FILL
    }

    private fun text(color: Int, size: Float, bold: Boolean = false, italic: Boolean = false) =
        Paint(Paint.ANTI_ALIAS_FLAG).apply {
            this.color = color
            textSize = size
            typeface = Typeface.create(
                Typeface.DEFAULT,
                when {
                    bold && italic -> Typeface.BOLD_ITALIC
                    bold -> Typeface.BOLD
                    italic -> Typeface.ITALIC
                    else -> Typeface.NORMAL
                }
            )
        }

    /** 너무 긴 글자는 끝을 잘라 "…" 로 맺는다. */
    private fun fit(paint: Paint, value: String, maxWidth: Float): String {
        if (maxWidth <= 0f || paint.measureText(value) <= maxWidth) return value
        var end = value.length
        while (end > 1 && paint.measureText(value.take(end) + "…") > maxWidth) {
            end--
        }
        return value.take(end) + "…"
    }
}
