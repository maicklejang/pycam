package org.pycam.bizcard

import android.graphics.Bitmap
import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView
import org.pycam.bizcard.databinding.ItemTemplateBinding

/**
 * 템플릿 고르기 줄. 미리보기에는 사용자가 지금 입력한 내용을 그대로 넣어 보여준다.
 */
class TemplateAdapter(
    private val onSelect: (CardTemplate) -> Unit
) : RecyclerView.Adapter<TemplateAdapter.Holder>() {

    private val templates = CardTemplates.ALL
    private var card: MyCard = MyCard()
    private var logo: Bitmap? = null

    /** 미리보기에 쓸 내용과 선택 상태를 갱신한다. [logo] 는 명함에 얹을 회사 로고. */
    fun update(card: MyCard, logo: Bitmap? = null) {
        this.card = card
        this.logo = logo
        notifyDataSetChanged()
    }

    override fun getItemCount(): Int = templates.size

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder {
        val binding = ItemTemplateBinding.inflate(LayoutInflater.from(parent.context), parent, false)
        return Holder(binding)
    }

    override fun onBindViewHolder(holder: Holder, position: Int) {
        holder.bind(templates[position])
    }

    inner class Holder(private val binding: ItemTemplateBinding) :
        RecyclerView.ViewHolder(binding.root) {

        fun bind(template: CardTemplate) {
            val selected = template.id == card.templateId
            binding.templateTitle.text = template.title
            binding.templatePreview.setImageBitmap(
                CardRenderer.render(card.copy(templateId = template.id), PREVIEW_WIDTH, logo)
            )
            binding.templateCard.setStrokeColor(
                if (selected) card.copy(templateId = template.id).resolvedAccent() else 0x22000000
            )
            binding.root.setOnClickListener { onSelect(template) }
        }
    }

    private companion object {
        /** 썸네일은 작게 그린다. 입력할 때마다 다시 그리기 때문이다. */
        const val PREVIEW_WIDTH = 360
    }
}
