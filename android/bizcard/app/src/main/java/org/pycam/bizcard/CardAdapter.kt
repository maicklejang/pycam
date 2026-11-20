package org.pycam.bizcard

import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView
import org.pycam.bizcard.databinding.ItemCardBinding

class CardAdapter(
    private val store: CardStore,
    private val onClick: (BizCard) -> Unit,
    private val onDelete: (BizCard) -> Unit
) : RecyclerView.Adapter<CardAdapter.CardViewHolder>() {

    private val items = ArrayList<BizCard>()

    fun submit(cards: List<BizCard>) {
        items.clear()
        items.addAll(cards)
        notifyDataSetChanged()
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): CardViewHolder {
        val binding = ItemCardBinding.inflate(LayoutInflater.from(parent.context), parent, false)
        return CardViewHolder(binding)
    }

    override fun getItemCount(): Int = items.size

    override fun onBindViewHolder(holder: CardViewHolder, position: Int) = holder.bind(items[position])

    inner class CardViewHolder(private val binding: ItemCardBinding) :
        RecyclerView.ViewHolder(binding.root) {

        fun bind(card: BizCard) {
            binding.nameText.text = card.displayName
            binding.subtitleText.text = card.displaySubtitle
            binding.contactText.text = listOf(card.mobile, card.phone, card.email)
                .firstOrNull { it.isNotBlank() }.orEmpty()

            binding.thumbnail.setImageBitmap(
                card.imageName.takeIf { it.isNotEmpty() }
                    ?.let { ImageUtils.decodeScaled(store.imageFile(it), THUMBNAIL_SIZE) }
            )

            binding.root.setOnClickListener { onClick(card) }
            binding.deleteButton.setOnClickListener { onDelete(card) }
        }
    }

    private companion object {
        const val THUMBNAIL_SIZE = 256
    }
}
